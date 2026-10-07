"""Fail-closed evidence and file bindings for this separately preserved release."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import re
import stat
import shutil
from tempfile import TemporaryDirectory

PRESERVED_SHA256 = 'fcaf4dcbc87ed2cb97bef15a1167982a754f8253514314305c5f065f7de06bdc'
PRESERVED_COUNT = 1278
SHA256 = re.compile(r'^[0-9a-f]{64}$')


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode()).hexdigest()


def managed_path(root, path):
    """Reject linked managed roots and ancestors, before reading or mutating."""
    root, path = root.absolute(), path.absolute()
    require(not root.is_symlink(), f'Managed root symlink: {root}')
    require(path.is_relative_to(root), f'Unsafe managed path: {path}')
    cursor = root
    for part in path.relative_to(root).parts:
        cursor = cursor / part
        require(not cursor.is_symlink(), f'Managed path symlink: {cursor}')
    require(path.resolve().is_relative_to(root.resolve()), f'Managed path escapes root: {path}')
    return path


def source_paths(root):
    """Code, tests and build inputs; document content/generators are not runtime inputs."""
    files = set()
    for folder in ('src', 'electron', 'config', '.github', 'qa', 'assets', 'public'):
        managed_path(root, root / folder)
        for path in (root / folder).rglob('*'):
            if '__pycache__' in path.parts or path.name == '.DS_Store':
                continue
            require(not path.is_symlink(), f'Source symlink: {path}')
            if folder == 'qa' and (path.name.startswith('build-') and path.name.endswith('-report.py')):
                continue
            if path.is_file():
                files.add(path)
    files.update(path for path in root.iterdir() if path.is_file() and
                 (path.suffix in ('.json', '.yaml', '.yml', '.ts', '.html', '.ico', '.png', '.svg') or path.name == '.npmrc'))
    require(files, 'Source manifest cannot be empty')
    for path in files:
        require(not path.is_symlink() and path.resolve().is_relative_to(root.resolve()), f'Unsafe source: {path}')
    return sorted(files)


def source_hashes(root):
    return {str(path.relative_to(root)): sha(path) for path in source_paths(root)}


def verify_hashes(root, expected, actual):
    require(isinstance(expected, dict) and expected and set(expected) == set(actual),
            'Source manifest missing, extra, or incomplete')
    for name, digest in expected.items():
        rel = PurePosixPath(name)
        require(not rel.is_absolute() and '..' not in rel.parts and str(rel) == name,
                f'Unsafe relative path: {name}')
        require(isinstance(digest, str) and SHA256.fullmatch(digest) and actual[name] == digest,
                f'Validated source changed: {root / name}')


def verify_acceptance(root, checks, version, finalize=False):
    acceptance = read_json(checks / 'final-acceptance.json')
    require(acceptance.get('version') == version, 'Wrong acceptance version')
    for flag in ('testsPassed', 'codeReviewApproved') + (('lifecycleAuditApproved',) if finalize else ()):
        require(acceptance.get(flag) is True, f'Approval must be boolean true: {flag}')
    actual = source_hashes(root)
    verify_hashes(root, acceptance.get('sourceHashes'), actual)
    digest = manifest_sha(actual)
    records = acceptance.get('evidenceHashes')
    require(isinstance(records, dict) and set(records) == {'test-validation.json', 'independent-code-review.json'},
            'Required test/review evidence bindings missing')
    for name, value in records.items():
        require(isinstance(value, str) and SHA256.fullmatch(value) and sha(checks / name) == value,
                f'Approval evidence changed: {name}')
        record = read_json(checks / name)
        require(record.get('status') == 'passed' and record.get('version') == version
                and record.get('sourceManifestSha256') == digest, f'Stale or incomplete approval evidence: {name}')
    return acceptance


def verify_preserved(checks, expected_sha=PRESERVED_SHA256, expected_count=PRESERVED_COUNT):
    path = checks / 'preserved-before.json'
    require(sha(path) == expected_sha, 'Original preservation manifest changed')
    records = read_json(path)
    require(isinstance(records, dict) and len(records) == expected_count and expected_count > 0, 'Incomplete preservation manifest')
    for name, digest in records.items():
        require(isinstance(digest, str) and SHA256.fullmatch(digest) and Path(name).is_absolute(),
                'Malformed preservation record')
        require(sha(Path(name)) == digest, f'Preserved file changed; investigate without restoring user data: {name}')
    return len(records)


def validate_dependency_gate(report):
    require(isinstance(report, dict) and isinstance(report.get('runtime'), dict), 'Dependency runtime missing')
    audit = report.get('audit')
    require(isinstance(audit, dict) and set(audit) == {'records', 'uniqueAdvisories', 'severity'},
            'Live dependency audit missing or malformed')
    severity = audit.get('severity')
    require(isinstance(severity, dict) and set(severity) == {'info', 'low', 'moderate', 'high', 'critical'},
            'Malformed severity counts')
    counts = [audit['records'], audit['uniqueAdvisories'], *severity.values()]
    require(all(type(value) is int and 0 <= value <= 2**53 - 1 for value in counts), 'Invalid audit counts')
    require(sum(severity.values()) == audit['records'] and audit['uniqueAdvisories'] <= audit['records'],
            'Inconsistent audit counts')
    require(severity['high'] == 0 and severity['critical'] == 0, 'High or critical dependency advisory present')
    return report


def app_manifest(app):
    """Include regular files, directories, permissions, and literal link targets."""
    require(app.is_dir() and not app.is_symlink(), 'App root is missing or a symlink')
    result = {}
    for directory, dirs, files in os.walk(app, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            key = str(path.relative_to(app))
            mode = path.lstat().st_mode
            entry = {'mode': stat.S_IMODE(mode)}
            if stat.S_ISLNK(mode):
                entry.update(type='symlink', target=os.readlink(path))
                require(path.resolve().is_relative_to(app.resolve()), f'App link escapes bundle: {key}')
            elif stat.S_ISREG(mode):
                entry.update(type='file', sha256=sha(path))
            elif stat.S_ISDIR(mode):
                entry.update(type='directory')
            else:
                raise RuntimeError(f'Unsupported bundle entry: {key}')
            result[key] = entry
    require(result, 'Empty application bundle')
    return result


def evidence_paths(checks, required, optional):
    require(set(required).isdisjoint(optional), 'Duplicate evidence categories')
    selected = []
    for name in sorted(set(required) | set(optional)):
        rel = PurePosixPath(name)
        require(not rel.is_absolute() and '..' not in rel.parts and str(rel) == name and name != '.', f'Unsafe evidence name: {name}')
        path = managed_path(checks, checks / name)
        if name not in required and not path.exists():
            continue
        require(path.is_file() and not path.is_symlink(), f'Required evidence absent or unsafe: {name}')
        selected.append(path)
    return selected


def staged_app_install(source, destination, verify):
    """Publish only a fully copied/verified bundle; cleanup belongs to this invocation."""
    require(not destination.exists() and not destination.is_symlink(), 'Separate app already exists; do not overwrite a release')
    with TemporaryDirectory(prefix='.app-install-', dir=destination.parent) as temporary:
        staged = Path(temporary) / destination.name
        shutil.copytree(source, staged, symlinks=True)
        verify(staged)
        manifest = app_manifest(staged)
        require(manifest == app_manifest(source), 'Complete app copy mismatch')
        require(not destination.exists() and not destination.is_symlink(), 'Separate app appeared during installation')
        staged.rename(destination)
    return manifest


def verify_round_evidence(checks, ledger, selected):
    """A valid selection hash does not prove the selection contains the audit chain."""
    required = {'ledger.json', 'final-acceptance.json', 'test-validation.json', 'independent-code-review.json',
                'independent-lifecycle-audit.json', 'delivery-install.json', 'delivery-native.json',
                'preserved-before.json', 'word-qa.json', 'evidence-selection.json'}
    for row in ledger['rounds']:
        for key in ('reviewReports', 'recheckReports'):
            required.update(f"round-{row['round']}/{name}" for name in row[key])
    actual = {path.relative_to(checks).as_posix() for path in selected}
    require(required <= actual, 'Required audit evidence omitted: ' + ', '.join(sorted(required - actual)))


def verify_build_receipts(root, dist=None):
    """Bind actual Vite build inputs to both renderer output trees."""
    dist = dist or root / 'dist'
    inputs = source_hashes(root)
    version = read_json(root / 'package.json')['version']
    results = {}
    for kind, directory in (('web', dist), ('review', dist / 'review')):
        managed_path(root if dist == root / 'dist' else dist, directory)
        require(not dist.is_symlink(), 'Build output root symlink')
        managed_path(directory, directory / 'build-provenance.json')
        receipt = read_json(directory / 'build-provenance.json')
        require(receipt.get('schemaVersion') == 1 and receipt.get('kind') == kind
                and receipt.get('status') == 'passed' and receipt.get('version') == version,
                'Invalid build receipt: ' + kind)
        verify_hashes(root, receipt.get('sourceHashes'), inputs)
        outputs = {}
        for file in directory.rglob('*'):
            relative = file.relative_to(directory)
            if relative.as_posix() == 'build-provenance.json' or (kind == 'web' and relative.parts[0] == 'review'):
                continue
            require(not file.is_symlink(), 'Build output symlink: ' + str(file))
            if file.is_file(): outputs[relative.as_posix()] = sha(file)
        verify_hashes(directory, receipt.get('outputHashes'), outputs)
        results[kind] = sha(directory / 'build-provenance.json')
    return results


def verify_lifecycle_approval(root, checks, version, app_hash):
    """A same-version boolean cannot approve another source or application."""
    acceptance = read_json(checks / 'final-acceptance.json')
    path = checks / 'independent-lifecycle-audit.json'
    require(acceptance.get('lifecycleAuditSha256') == sha(path), 'Lifecycle report changed or is unbound')
    report = read_json(path)
    require(report.get('applicationVersion') == version
            and report.get('verdict', {}).get('codeAndNativeApproved') is True,
            'Lifecycle approval is missing')
    require(report.get('sourceManifestSha256') == manifest_sha(source_hashes(root)), 'Stale lifecycle source')
    require(report.get('appManifestSha256') == app_hash, 'Stale lifecycle application')
    expected = {name: sha(checks / name) for name in ('test-validation.json', 'independent-code-review.json')}
    require(report.get('evidenceHashes') == expected, 'Stale lifecycle evidence')
    return report


def verify_round_ledger(root, checks):
    ledger = read_json(checks / 'ledger.json')
    rounds = ledger.get('rounds')
    require(isinstance(rounds, list) and len(rounds) >= 5, 'At least five audit rounds required')
    previous = None
    for index, row in enumerate(rounds, 1):
        require(row.get('round') == index and row.get('status') == 'closed', 'Audit round is missing or open')
        require(type(row.get('confirmedFindings')) is int and row['confirmedFindings'] >= 0
                and type(row.get('closedFindings')) is int and row['closedFindings'] == row['confirmedFindings'], 'Unclosed audit findings')
        require(isinstance(row.get('inputSourceManifestSha256'), str)
                and SHA256.fullmatch(row['inputSourceManifestSha256']), 'Round input source digest missing')
        if previous is not None:
            require(row.get('inputSourceManifestSha256') == previous, 'Audit round source chain is broken')
        previous = row.get('outputSourceManifestSha256')
        require(isinstance(previous, str) and SHA256.fullmatch(previous), 'Round source digest missing')
        directory = checks / f'round-{index}'
        for phase, key in [('review', 'reviewReports'), ('recheck', 'recheckReports')]:
            expected = {f'{party}-{phase}.json' for party in 'abc'}
            bindings = row.get(key)
            require(isinstance(bindings, dict) and set(bindings) == expected, 'Three-party report bindings missing')
            for name, digest in bindings.items():
                path = managed_path(checks, directory / name)
                require(sha(path) == digest, 'Audit report changed: ' + name)
                report = read_json(path)
                expected_source = row.get('inputSourceManifestSha256') if phase == 'review' else previous
                require(report.get('sourceManifestSha256') == expected_source, 'Audit report covers another source: ' + name)
                if phase == 'review':
                    require(len(report.get('coverage', [])) == 8, 'Incomplete lifecycle layer coverage')
                else:
                    closure = report.get('closure')
                    require(isinstance(closure, dict) and closure.get('approved') is True
                            and type(closure.get('openFindingIds')) is list and not closure['openFindingIds'],
                            'Three-party closure not approved: ' + name)
    require(previous == manifest_sha(source_hashes(root)), 'Final round does not cover current source')
    return ledger
