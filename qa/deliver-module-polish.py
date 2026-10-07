"""Shared preserved-release installation and finalization with fresh runtime verification."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from delivery_contract import (require, read_json, sha, manifest_sha, source_hashes,
                               verify_acceptance, verify_preserved as preserved_contract,
                               validate_dependency_gate, app_manifest, evidence_paths, verify_build_receipts, verify_lifecycle_approval, verify_round_ledger,
                               staged_app_install, verify_round_evidence)

ROOT = Path(__file__).resolve().parents[1]
# Fixed profiles share one implementation; historical entry keeps its defaults.
PROFILE = globals().get('DELIVERY_PROFILE', {})
CHECKS = ROOT / PROFILE.get('checks', 'artifacts/module-polish-20261001')
VERSION = PROFILE.get('version', '1.5.2')
OUT = Path(PROFILE.get('destination', '/Users/fengjinwen/Desktop/a股/细节打磨版1.5.2'))
BUILT = ROOT / 'release-builder/mac-arm64/A股雷达趋势版.app'
INSTALLED = OUT / BUILT.name
REPORT = OUT / PROFILE.get('report', '模块打磨与独立审计报告.docx')


def verify_preserved():
    return preserved_contract(CHECKS, **PROFILE.get('preservation', {}))


def production_files():
    files = [p for p in (ROOT / 'electron').glob('*.cjs')
             if not p.name.endswith('.test.cjs') and not p.name.startswith(('build-', 'deploy-'))]
    files += [p for p in (ROOT / 'config').glob('*.json')]
    files += [p for p in (ROOT / 'assets').rglob('*') if p.is_file()]
    files += [p for p in (ROOT / 'dist').rglob('*') if p.is_file()]
    return sorted(files)


def verify_app(app):
    resources = app / 'Contents/Resources/app'
    verify_build_receipts(ROOT)
    verify_build_receipts(ROOT, resources / 'dist')
    require(read_json(resources / 'package.json')['version'] == VERSION, 'Wrong packaged version')
    for source in production_files():
        require(sha(source) == sha(resources / source.relative_to(ROOT)), f'Packaged source mismatch: {source}')
    env = {**os.environ, 'ELECTRON_RUN_AS_NODE': '1'}
    result = subprocess.run([str(app / 'Contents/MacOS/A股雷达趋势版'), '-p', 'JSON.stringify(process.versions)'],
                            capture_output=True, text=True, env=env, timeout=30, check=True)
    versions = json.loads(result.stdout)
    expected = read_json(ROOT / 'package.json')['devDependencies']['electron']
    require(versions['electron'] == expected, 'Packaged Electron differs from the manifest')
    require(versions['undici'] == '7.29.1', 'Packaged embedded network runtime differs from the reviewed release')
    return versions


def verified_zip(target, sources, prefix):
    require(not target.exists(), f'Refuse to overwrite an existing archive: {target}')
    for source in sources:
        require(not source.is_symlink() and source.resolve().is_relative_to(ROOT), f'Unsafe archive input: {source}')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for source in sorted(sources):
            archive.write(source, prefix / source.relative_to(ROOT))
    with zipfile.ZipFile(target) as archive:
        require(archive.testzip() is None, f'CRC failed: {target}')
        for source in sources:
            entry = str(prefix / source.relative_to(ROOT))
            require(hashlib.sha256(archive.read(entry)).hexdigest() == sha(source), f'Archived content mismatch: {entry}')
    return {'file': target.name, 'filesVerified': len(sources), 'sha256': sha(target)}


mode = sys.argv[1] if len(sys.argv) == 2 else ''
require(mode in ('install', 'finalize'), 'Usage: python qa/deliver-current.py install|finalize')
require(read_json(ROOT / 'package.json')['version'] == VERSION, 'Wrong source version')
acceptance = verify_acceptance(ROOT, CHECKS, VERSION, finalize=mode == 'finalize')
preserved_count = verify_preserved()
OUT.mkdir(parents=True, exist_ok=True)

if mode == 'install':
    require(not INSTALLED.exists(), 'Separate app already exists; do not overwrite a release')
    # This local delivery entry is also fail-closed on live high/critical audit
    # results or an unavailable/malformed audit response.
    command = subprocess.run(['node', 'qa/verify-dependencies.cjs', '--audit'], cwd=ROOT,
                             capture_output=True, text=True, timeout=150)
    (CHECKS / 'delivery-dependencies.log').write_text(command.stdout + command.stderr)
    require(command.returncode == 0, 'Fresh dependency security gate failed; see delivery-dependencies.log')
    dependencies = validate_dependency_gate(json.loads(command.stdout))
    runtime = verify_app(BUILT)
    require(runtime == dependencies['runtime'], 'Built and installed dependency runtimes differ')
    built_manifest = app_manifest(BUILT)
    installed_manifest = staged_app_install(BUILT, INSTALLED, verify_app)
    require(installed_manifest == built_manifest, 'Complete app copy mismatch')
    evidence = {'version': VERSION, 'appPath': str(INSTALLED),
                'appManifestSha256': manifest_sha(installed_manifest),
                'appEntriesVerified': len(installed_manifest),
                'allRegularAppFilesVerified': sum(row['type'] == 'file' for row in installed_manifest.values()),
                'productionFilesVerified': len(production_files()), 'preservedFilesVerified': preserved_count,
                'runtime': runtime, 'dependencyAudit': dependencies['audit']}
    (CHECKS / 'delivery-install.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
else:
    if PROFILE.get('fiveRoundsRequired'):
        round_ledger = verify_round_ledger(ROOT, CHECKS)
    runtime = verify_app(INSTALLED)
    native = read_json(CHECKS / 'delivery-native.json')
    require(native['status'] == 'passed' and native['appPath'] == str(INSTALLED) and native['version'] == VERSION,
            'Native validation is absent or targets another app')
    current_app_hash = manifest_sha(app_manifest(INSTALLED))
    require(native.get('appManifestSha256') == current_app_hash
            and read_json(CHECKS / 'delivery-install.json').get('appManifestSha256') == current_app_hash,
            'Complete native app changed after installation or validation')
    lifecycle = verify_lifecycle_approval(ROOT, CHECKS, VERSION, current_app_hash)
    word_qa = read_json(CHECKS / 'word-qa.json')
    require(word_qa['status'] == 'passed' and word_qa['sha256'] == sha(REPORT), 'Report changed after visual QA')
    source_files = set()
    for folder in ['src', 'electron', 'qa', 'docs', 'assets', 'config', '.github']:
        source_files.update(p for p in (ROOT / folder).rglob('*') if p.is_file()
                            and '__pycache__' not in p.parts and p.name != '.DS_Store')
    source_files.update(p for p in ROOT.iterdir() if p.is_file() and
                        (p.suffix in ['.json', '.yaml', '.yml', '.ts', '.md', '.html', '.cmd', '.ico', '.png']
                         or p.name in ['.gitignore', 'LICENSE', '.npmrc']))
    selection_path = ROOT / PROFILE.get('evidenceSelection', 'qa/module-polish-evidence.json')
    if PROFILE.get('fiveRoundsRequired'):
        require(acceptance.get('evidenceSelectionSha256') == sha(selection_path), 'Evidence selection changed or unbound')
    evidence_selection = read_json(selection_path)
    evidence_files = evidence_paths(CHECKS, evidence_selection['required'], evidence_selection['optional'])
    if PROFILE.get('fiveRoundsRequired'):
        verify_round_evidence(CHECKS, round_ledger, evidence_files)
    source_archive = verified_zip(OUT / 'a-stock-radar-tader源码.zip', source_files, Path('a-stock-radar-tader'))
    evidence_archive = verified_zip(OUT / '审计验证证据.zip', evidence_files, Path())
    default_readme = '''A股雷达趋势版 1.5.2 · 细节打磨版

双击本目录中的 A股雷达趋势版.app 使用。1.4.6、1.5.0、1.5.1应用及旧源码/报告全部保留。
各版本沿用同一本机资料，请先正常退出其中一个，再打开另一个。

本版改善中文输入搜索、本地记录恢复、复盘档案、上海日期、缺失数值、缓存效率、重复搜索请求、worker取消及故障日志。
实际升级Electron及兼容传递依赖，增加依赖/二进制一致性与高危审计发布门禁。策略评分和原有参数保持兼容。

逐模块清单、风险高/中/低、整改与独立生命周期复核见Word报告。
交付验证记录.json与审计验证证据.zip保留可追溯结果；审计无匹配公告不代表没有其他漏洞。
未执行全市场实测、长时稳定性验收或Windows/Linux原生运行。缓存微基准不代表整体性能提升。

源码不含node_modules或用户配置/密钥/观察池文件。先按锁文件安装依赖，可运行 pnpm verify:fullstack。
浏览器测试需要Chrome，可设置QA_CHROMIUM_PATH。安全门禁需要访问依赖审计服务，服务失败时会阻断。
证据包可解压到源码根目录；Word报告脚本读取对应artifacts目录。ZIP逐文件核验，不承诺跨环境逐字节确定性。
'''
    (OUT / '先读我.txt').write_text(PROFILE.get('readme', default_readme), encoding='utf-8')
    evidence = {'version': VERSION, 'deliveredAt': datetime.datetime.now().astimezone().isoformat(),
                'destination': str(OUT), 'preservedFilesVerified': preserved_count,
                'productionFilesVerified': len(production_files()), 'runtime': runtime,
                'sourceArchive': source_archive, 'evidenceArchive': evidence_archive,
                'reportSha256': sha(REPORT), 'native': native,
                'validation': read_json(CHECKS / 'test-validation.json'),
                'independentAudit': read_json(CHECKS / 'independent-lifecycle-audit.json')}
    rendered = json.dumps(evidence, ensure_ascii=False, indent=2)
    (CHECKS / 'delivery.json').write_text(rendered)
    (OUT / '交付验证记录.json').write_text(rendered)

verify_preserved()
print(json.dumps({'mode': mode, 'version': VERSION, 'destination': str(OUT)}, ensure_ascii=False))
