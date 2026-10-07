"""Package the audited 1.5.1 release without replacing the user's earlier apps."""
from pathlib import Path
import datetime
import hashlib
import json
import shutil
import sys
import zipfile

repo = Path(__file__).resolve().parents[1]
checks = repo / 'artifacts/fullstack-audit-20261001'
destination = Path('/Users/fengjinwen/Desktop/a股/全栈审计优化版1.5.1')
built_app = repo / 'release-builder/mac-arm64/A股雷达趋势版.app'
resources = built_app / 'Contents/Resources/app'
installed_app = destination / built_app.name


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def preserved():
    original = json.loads((checks / 'preserved-before-delivery.json').read_text())
    actual = {name: sha(Path(name)) for name in original}
    require(actual == original, 'A preserved release or profile file changed; investigate before delivery')
    return actual


def production_files():
    paths = [p for p in (repo / 'electron').glob('*.cjs')
             if not p.name.endswith('.test.cjs') and not p.name.startswith(('build-', 'deploy-'))]
    paths += list((repo / 'config').glob('*.json'))
    paths += [p for p in (repo / 'dist').rglob('*') if p.is_file()]
    return sorted(paths)


def verify_package(app):
    root = app / 'Contents/Resources/app'
    require(json.loads((root / 'package.json').read_text())['version'] == '1.5.1', 'Wrong app version')
    for path in production_files():
        require(sha(path) == sha(root / path.relative_to(repo)), f'Packaged source mismatch: {path}')


mode = sys.argv[1] if len(sys.argv) == 2 else ''
require(mode in ('install', 'finalize'), 'Usage: python qa/deliver-current.py install|finalize')
require(json.loads((repo / 'package.json').read_text())['version'] == '1.5.1', 'Wrong source version')
validation = json.loads((checks / 'test-validation.json').read_text())
review = json.loads((checks / 'final-review.json').read_text())
require(validation['status'] == 'passed', 'Independent validation not passed')
require(review['status'] == 'pass_with_documented_limits' and not review['open_findings'], 'Review has blockers')
frozen = json.loads((checks / 'iteration2-freeze-manifest.json').read_text())
for name, digest in frozen['files'].items():
    require(sha(repo / name) == digest, f'Validated source changed: {name}')
before = preserved()
verify_package(built_app)
destination.mkdir(parents=True, exist_ok=True)

if mode == 'install':
    require(not installed_app.exists(), 'Destination app already exists; never overwrite an unknown release')
    shutil.copytree(built_app, installed_app, symlinks=True)
    verify_package(installed_app)
    files = [p for p in built_app.rglob('*') if p.is_file() and not p.is_symlink()]
    for path in files:
        require(sha(path) == sha(installed_app / path.relative_to(built_app)), f'App copy mismatch: {path}')
    copied = {'version': '1.5.1', 'allRegularAppFilesVerified': len(files),
              'productionFilesVerified': len(production_files()), 'preservedFingerprints': len(before)}
    (checks / 'delivery-install.json').write_text(json.dumps(copied, ensure_ascii=False, indent=2))
else:
    verify_package(installed_app)
    native = json.loads((checks / 'delivery-native.json').read_text())
    require(native['status'] == 'passed', 'Native launch has not been verified')
    require(native['appPath'] == str(installed_app) and native['version'] == '1.5.1', 'Native check targets another app')
    require(native['packageSha256'] == sha(installed_app / 'Contents/Resources/app/package.json'), 'Native package changed')
    require(native['mainSha256'] == sha(installed_app / 'Contents/Resources/app/electron/main.cjs'), 'Native entry changed')
    report = destination / '全栈审计与优化报告.docx'
    require(report.is_file() and report.stat().st_size > 10000, 'Word report missing')
    word_qa = json.loads((checks / 'word-qa.json').read_text())
    require(word_qa['status'] == 'passed' and word_qa['sha256'] == sha(report), 'Word report changed after visual QA')
    selected = set()
    for folder in ['src', 'electron', 'qa', 'docs', 'assets', 'config', '.github']:
        selected.update(p for p in (repo / folder).rglob('*')
                        if p.is_file() and '__pycache__' not in p.parts and p.name != '.DS_Store')
    selected.update(p for p in repo.iterdir() if p.is_file() and
                    (p.suffix in ['.json', '.yaml', '.yml', '.ts', '.md', '.html', '.cmd', '.ico', '.png']
                     or p.name in ['.gitignore', 'LICENSE', '.npmrc']))
    source_zip = destination / 'a-stock-radar-tader源码.zip'
    require(not source_zip.exists(), 'Source archive already exists; do not replace an unknown delivery')
    with zipfile.ZipFile(source_zip, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(selected):
            archive.write(path, Path('a-stock-radar-tader') / path.relative_to(repo))
    with zipfile.ZipFile(source_zip) as archive:
        require(archive.testzip() is None, 'Source archive CRC failed')
        for path in selected:
            data = archive.read('a-stock-radar-tader/' + str(path.relative_to(repo)))
            require(hashlib.sha256(data).hexdigest() == sha(path), f'Archive source mismatch: {path}')
    evidence_zip = destination / '审计验证证据.zip'
    require(not evidence_zip.exists(), 'Evidence archive already exists; do not replace an unknown delivery')
    evidence_files = [p for p in checks.iterdir() if p.is_file()
                      and p.suffix in ['.json', '.log', '.diff']
                      and p.name not in ['preserved-before-delivery.json', 'baseline-hashes.json', 'delivery.json']]
    evidence_files += [checks / phase / 'load-results.json' for phase in ['loopback-baseline', 'loopback-final']]
    with zipfile.ZipFile(evidence_zip, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(evidence_files):
            archive.write(path, path.relative_to(repo))
    with zipfile.ZipFile(evidence_zip) as archive:
        require(archive.testzip() is None, 'Evidence archive CRC failed')
        for path in evidence_files:
            require(hashlib.sha256(archive.read(str(path.relative_to(repo)))).hexdigest() == sha(path),
                    f'Evidence archive mismatch: {path}')
    (destination / '先读我.txt').write_text('''A股雷达趋势版 1.5.1 · 全栈审计优化版

双击本文件夹中的 A股雷达趋势版.app 使用。
旧版1.4.6、改版前保留_1.4.6、重构版1.5.0均未覆盖；新旧版共用本机业务数据，请先正常退出其中一个再打开另一个。

本轮修复
1. 设置加载、排队保存、失败回退和编辑草稿的并发覆盖。
2. 持仓保存返回时误清除正在编辑的另一条记录。
3. 组合筛选票数被降低、优化结果复用条件过宽及同策略重复计票。
4. 专业复盘五个指数图表的身份校验与股票代码隔离。
5. 请求队列拥堵被误判为数据源故障。
6. 配置文件类型校验、备份恢复、敏感配置单次提交及故障回滚。
7. Windows托盘创建失败后的窗口可见性与资源释放。
8. 前后端设置规范化契约与HTTP超时测试时序。

功能、策略算法及现有参数保持兼容。本轮没有新增选股策略或改版界面。
详细分层问题、优先级、实施建议和验证范围见Word报告。
运行时与工具链依赖升级已列入报告方案，尚未实施；不能将本版视为没有安全风险。

验证：第一轮默认702项通过；最后一次前端增量通过16项浏览器回归、6项相关单测、3项独立探针及两套类型检查。
已完成Web/复盘构建、macOS arm64打包和本机启动检查。没有进行全市场实测、长时间稳定性验收或Windows/Linux原生测试。

源码内可执行 pnpm verify:fullstack（需先安装锁文件指定依赖，并安装可用的Chrome；可通过QA_CHROMIUM_PATH指定浏览器路径）。
交付验证记录.json保留检查摘要；审计验证证据.zip包含分层发现、差异、测试日志及构建证据，可解压到源码根目录供报告脚本读取。
源码与证据包不包含本机账户配置、密钥或个人观察池文件；未包含node_modules，源码压缩包按文件内容逐项核对，不承诺跨环境逐字节相同的ZIP。
''', encoding='utf-8')
    manifest = {
        'version': '1.5.1', 'deliveredAt': datetime.datetime.now().astimezone().isoformat(),
        'destination': str(destination), 'preservedVersions': ['1.4.6', '1.5.0'],
        'preservedFingerprints': len(before), 'productionFilesVerified': len(production_files()),
        'sourceFilesVerified': len(selected), 'sourceSha256': sha(source_zip),
        'evidenceFilesVerified': len(evidence_files), 'evidenceSha256': sha(evidence_zip),
        'reportSha256': sha(report), 'native': native,
        'testValidation': validation, 'reviewStatus': review['status'],
        'dependencyUpgradesImplemented': False,
    }
    rendered = json.dumps(manifest, ensure_ascii=False, indent=2)
    (checks / 'delivery.json').write_text(rendered)
    (destination / '交付验证记录.json').write_text(rendered)

preserved()
print(json.dumps({'mode': mode, 'version': '1.5.1', 'destination': str(destination),
                  'productionFilesVerified': len(production_files())}, ensure_ascii=False))
