"""Regression cases for independent delivery findings; temporary data only."""
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import unittest
from unittest.mock import patch
from delivery_contract import (app_manifest, evidence_paths, manifest_sha, source_hashes,
                               validate_dependency_gate, verify_acceptance, verify_preserved, sha)
import delivery_contract as contract


class DeliveryContractTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'src').mkdir()
        (self.root / 'src/main.ts').write_text('original')
        (self.root / 'package.json').write_text('{"version":"1.5.2"}')
        self.checks = self.root / 'artifacts'
        self.checks.mkdir()
        self.acceptance = {'version': '1.5.2', 'testsPassed': True, 'codeReviewApproved': True,
                           'lifecycleAuditApproved': True, 'sourceHashes': source_hashes(self.root)}
        record = {'version': '1.5.2', 'status': 'passed',
                  'sourceManifestSha256': manifest_sha(self.acceptance['sourceHashes'])}
        self.acceptance['evidenceHashes'] = {}
        for name in ('test-validation.json', 'independent-code-review.json'):
            self.write(name, record)
            self.acceptance['evidenceHashes'][name] = sha(self.checks / name)
        self.save()

    def write(self, name, value):
        (self.checks / name).write_text(json.dumps(value))

    def save(self):
        self.write('final-acceptance.json', self.acceptance)

    def verify(self):
        return verify_acceptance(self.root, self.checks, '1.5.2', finalize=True)

    def test_real_booleans_and_bound_evidence(self):
        self.verify()
        for flag in ('testsPassed', 'codeReviewApproved', 'lifecycleAuditApproved'):
            for value in ('false', 1, None, False):
                with self.subTest(flag=flag, value=value):
                    self.acceptance[flag] = value
                    self.save()
                    with self.assertRaises(RuntimeError):
                        self.verify()
            self.acceptance[flag] = True
        self.save()
        self.write('test-validation.json', {'status': 'passed'})
        with self.assertRaises(RuntimeError):
            self.verify()

    def test_incomplete_or_stale_source_manifest(self):
        original = self.acceptance['sourceHashes']
        for bad in ({}, {'src/main.ts': original['src/main.ts']}, {'../outside': '0' * 64}):
            self.acceptance['sourceHashes'] = bad
            self.save()
            with self.assertRaises(RuntimeError):
                self.verify()
        self.acceptance['sourceHashes'] = original
        self.save()
        (self.root / 'src/main.ts').write_text('changed')
        with self.assertRaises(RuntimeError):
            self.verify()

    def test_assets_and_icons_participate_in_frozen_source(self):
        (self.root / 'assets').mkdir()
        (self.root / 'assets/icon.svg').write_text('old-icon')
        (self.root / 'app-icon.png').write_bytes(b'old-root-icon')
        before = source_hashes(self.root)
        (self.root / 'assets/icon.svg').write_text('new-icon')
        self.assertNotEqual(before, source_hashes(self.root))
        before = source_hashes(self.root)
        (self.root / 'app-icon.png').write_bytes(b'new-root-icon')
        self.assertNotEqual(before, source_hashes(self.root))

    def test_build_receipt_rejects_stale_source_and_changed_outputs(self):
        verify = getattr(contract, 'verify_build_receipts', None)
        self.assertTrue(callable(verify), 'build input/output verification exists')
        for kind, folder in [('web', 'dist'), ('review', 'dist/review')]:
            target = self.root / folder
            target.mkdir(parents=True, exist_ok=True)
            (target / 'module.js').write_text('compiled')
            receipt = {'schemaVersion': 1, 'kind': kind, 'version': '1.5.2', 'status': 'passed',
                       'sourceHashes': source_hashes(self.root), 'outputHashes': {'module.js': sha(target / 'module.js')}}
            (target / 'build-provenance.json').write_text(json.dumps(receipt))
        verify(self.root)
        (self.root / 'src/main.ts').write_text('different input but stale renderer')
        with self.assertRaises(RuntimeError): verify(self.root)
        (self.root / 'src/main.ts').write_text('original')
        (self.root / 'dist/module.js').write_text('tampered output')
        with self.assertRaises(RuntimeError): verify(self.root)

    def test_lifecycle_approval_binds_exact_source_app_and_evidence(self):
        verify = getattr(contract, 'verify_lifecycle_approval', None)
        self.assertTrue(callable(verify), 'lifecycle approval verifier exists')
        evidence = {name: sha(self.checks / name) for name in ('test-validation.json', 'independent-code-review.json')}
        approval = {'applicationVersion': '1.5.2', 'sourceManifestSha256': manifest_sha(source_hashes(self.root)),
                    'appManifestSha256': 'a' * 64, 'evidenceHashes': evidence,
                    'verdict': {'codeAndNativeApproved': True}}
        self.write('independent-lifecycle-audit.json', approval)
        self.acceptance['lifecycleAuditSha256'] = sha(self.checks / 'independent-lifecycle-audit.json')
        self.save()
        verify(self.root, self.checks, '1.5.2', 'a' * 64)
        for field in ('sourceManifestSha256', 'appManifestSha256'):
            changed = {**approval, field: '0' * 64}
            self.write('independent-lifecycle-audit.json', changed)
            # Even re-hashing a stale report cannot approve the current build.
            self.acceptance['lifecycleAuditSha256'] = sha(self.checks / 'independent-lifecycle-audit.json')
            self.save()
            with self.assertRaises(RuntimeError): verify(self.root, self.checks, '1.5.2', 'a' * 64)
        self.write('independent-lifecycle-audit.json', approval)
        self.acceptance['lifecycleAuditSha256'] = sha(self.checks / 'independent-lifecycle-audit.json')
        self.save()
        self.write('test-validation.json', {'status': 'changed'})
        with self.assertRaises(RuntimeError): verify(self.root, self.checks, '1.5.2', 'a' * 64)

    def test_empty_preservation_record_is_rejected(self):
        self.write('preserved-before.json', {})
        with self.assertRaises(RuntimeError):
            verify_preserved(self.checks)

    def test_audit_schema_counts_and_high_risk(self):
        clean = {'runtime': {'electron': '43.7.5'}, 'audit': {'records': 0, 'uniqueAdvisories': 0,
                 'severity': dict.fromkeys(('info', 'low', 'moderate', 'high', 'critical'), 0)}}
        validate_dependency_gate(clean)
        variants = ['not requested', {}, {'records': False, 'uniqueAdvisories': 0, 'severity': clean['audit']['severity']}]
        for audit in variants:
            with self.assertRaises(RuntimeError):
                validate_dependency_gate({**clean, 'audit': audit})
        for key, value in (('high', 1), ('critical', 1), ('low', -1), ('info', True)):
            bad = json.loads(json.dumps(clean))
            bad['audit']['severity'][key] = value
            with self.assertRaises(RuntimeError):
                validate_dependency_gate(bad)

    def test_complete_app_tracks_renderer_permissions_and_links(self):
        app = self.root / 'Test.app'
        app.mkdir()
        (app / 'renderer.js').write_text('original')
        (app / 'link').symlink_to('renderer.js')
        original = manifest_sha(app_manifest(app))
        (app / 'renderer.js').write_text('changed')
        self.assertNotEqual(original, manifest_sha(app_manifest(app)))
        changed = manifest_sha(app_manifest(app))
        (app / 'renderer.js').chmod(0o700)
        self.assertNotEqual(changed, manifest_sha(app_manifest(app)))
        (app / 'link').unlink()
        (app / 'link').symlink_to('../package.json')
        with self.assertRaises(RuntimeError):
            app_manifest(app)

    def test_managed_directory_symlinks_are_rejected(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (self.root / 'dist').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(RuntimeError): contract.verify_build_receipts(self.root)
        (self.root / 'assets').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(RuntimeError): source_hashes(self.root)

    def test_nested_evidence_is_explicit_and_rejects_parent_links_and_traversal(self):
        nested = self.checks / 'round-1'
        nested.mkdir()
        (nested / 'a-review.json').write_text('{}')
        self.assertEqual(len(evidence_paths(self.checks, ['round-1/a-review.json'], [])), 1)
        for name in ('../package.json', '/tmp/no.json', './test-validation.json'):
            with self.assertRaises(RuntimeError): evidence_paths(self.checks, [name], [])
        (self.checks / 'alias').symlink_to(nested, target_is_directory=True)
        with self.assertRaises(RuntimeError): evidence_paths(self.checks, ['alias/a-review.json'], [])

    def test_five_round_closure_binds_all_reports_and_final_source(self):
        rounds = []
        digest = manifest_sha(source_hashes(self.root))
        for index in range(1, 6):
            folder = self.checks / f'round-{index}'
            folder.mkdir()
            row = {'round': index, 'status': 'closed', 'confirmedFindings': 0, 'closedFindings': 0,
                   'inputSourceManifestSha256': digest, 'outputSourceManifestSha256': digest}
            for phase, key in [('review', 'reviewReports'), ('recheck', 'recheckReports')]:
                row[key] = {}
                for party in 'abc':
                    name = f'{party}-{phase}.json'
                    (folder / name).write_text(json.dumps({'coverage': list(range(8)), 'status': 'passed', 'sourceManifestSha256': digest, 'closure': {'approved': True, 'openFindingIds': []}}))
                    row[key][name] = sha(folder / name)
            rounds.append(row)
        self.write('ledger.json', {'rounds': rounds})
        contract.verify_round_ledger(self.root, self.checks)
        original = json.loads(json.dumps(rounds))
        rounds[0].pop('inputSourceManifestSha256')
        for party in 'abc':
            path = self.checks / 'round-1' / f'{party}-review.json'
            report = json.loads(path.read_text()); report.pop('sourceManifestSha256')
            path.write_text(json.dumps(report)); rounds[0]['reviewReports'][path.name] = sha(path)
        self.write('ledger.json', {'rounds': rounds})
        with self.assertRaises(RuntimeError): contract.verify_round_ledger(self.root, self.checks)
        rounds = original
        for party in 'abc':
            path = self.checks / 'round-1' / f'{party}-review.json'
            report = json.loads(path.read_text()); report['sourceManifestSha256'] = digest
            path.write_text(json.dumps(report)); rounds[0]['reviewReports'][path.name] = sha(path)
        for changed in [rounds[:4], [{**rounds[0], 'status': 'open'}, *rounds[1:]],
                        [*rounds[:-1], {**rounds[-1], 'confirmedFindings': 1}]]:
            self.write('ledger.json', {'rounds': changed})
            with self.assertRaises(RuntimeError): contract.verify_round_ledger(self.root, self.checks)
        self.write('ledger.json', {'rounds': rounds})
        target = self.checks / 'round-5/c-recheck.json'
        good = json.loads(target.read_text())
        for mutation in ({'closure': {'approved': False, 'openFindingIds': ['open']}},
                         {'closure': {'approved': 'true', 'openFindingIds': []}},
                         {'sourceManifestSha256': '0' * 64}):
            target.write_text(json.dumps({**good, **mutation}))
            rounds[-1]['recheckReports']['c-recheck.json'] = sha(target)
            self.write('ledger.json', {'rounds': rounds})
            with self.assertRaises(RuntimeError): contract.verify_round_ledger(self.root, self.checks)
        target.write_text(json.dumps(good))
        rounds[-1]['recheckReports']['c-recheck.json'] = sha(target)
        self.write('ledger.json', {'rounds': rounds})
        (self.checks / 'round-5/c-review.json').write_text('{}')
        with self.assertRaises(RuntimeError): contract.verify_round_ledger(self.root, self.checks)

    def test_unknown_evidence_excluded_and_missing_required_fails(self):
        self.write('unexpected-profile-export.json', {'token': 'synthetic'})
        selected = evidence_paths(self.checks, ['test-validation.json'], ['optional.log'])
        self.assertEqual([p.name for p in selected], ['test-validation.json'])
        with self.assertRaises(RuntimeError):
            evidence_paths(self.checks, ['missing.json'], [])
        (self.checks / 'optional.log').symlink_to('unexpected-profile-export.json')
        with self.assertRaises(RuntimeError):
            evidence_paths(self.checks, ['test-validation.json'], ['optional.log'])

    def test_round_report_set_is_mandatory_even_when_selection_is_hash_bound(self):
        verify = getattr(contract, 'verify_round_evidence', None)
        self.assertTrue(callable(verify))
        ledger = {'rounds': [{'round': i, 'reviewReports': {f'{p}-review.json': 'a'*64 for p in 'abc'},
                             'recheckReports': {f'{p}-recheck.json': 'b'*64 for p in 'abc'}} for i in range(1, 6)]}
        names = {'ledger.json', 'final-acceptance.json', 'test-validation.json', 'independent-code-review.json',
                 'independent-lifecycle-audit.json', 'delivery-install.json', 'delivery-native.json',
                 'preserved-before.json', 'word-qa.json', 'evidence-selection.json'}
        names |= {f'round-{i}/{p}-{phase}.json' for i in range(1, 6) for p in 'abc' for phase in ('review','recheck')}
        paths = [self.checks / name for name in names]
        verify(self.checks, ledger, paths)
        with self.assertRaises(RuntimeError): verify(self.checks, ledger, [p for p in paths if p.name != 'b-review.json'])
        with self.assertRaises(RuntimeError): verify(self.checks, ledger, [p for p in paths if p.name != 'final-acceptance.json'])

    def test_failed_staged_copy_and_validation_leave_no_partial_release_and_retry_is_safe(self):
        install = getattr(contract, 'staged_app_install', None)
        self.assertTrue(callable(install))
        source = self.root / 'built.app'; source.mkdir(); (source/'main').write_text('good')
        out = self.root / 'delivery'; out.mkdir(); target = out/'installed.app'
        sentinel = out/'prior.txt'; sentinel.write_text('preserve')
        def interrupted_copy(source, destination, **kwargs):
            destination.mkdir(); (destination/'partial').write_text('bad'); raise OSError('disk failed')
        with patch('shutil.copytree', interrupted_copy), self.assertRaises(OSError): install(source,target,lambda app: None)
        self.assertEqual(set(out.iterdir()), {sentinel})
        def reject(app): raise RuntimeError('invalid copied app')
        with self.assertRaises(RuntimeError): install(source,target,reject)
        self.assertEqual(set(out.iterdir()), {sentinel})
        install(source,target,lambda app: self.assertEqual((app/'main').read_text(),'good'))
        with self.assertRaises(RuntimeError): install(source,target,lambda app: None)
        self.assertEqual((target/'main').read_text(),'good'); self.assertEqual(sentinel.read_text(),'preserve')


if __name__ == '__main__':
    unittest.main()
