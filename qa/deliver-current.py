"""Deliver the current audited release without replacing earlier releases."""
import json
from pathlib import Path
from runpy import run_path

REPO = Path(__file__).resolve().parents[1]
VERSION = json.loads((REPO / 'package.json').read_text(encoding='utf-8'))['version']
PROFILE = {
    'version': VERSION,
    'checks': f'artifacts/six-dimension-audit-{VERSION.replace(".", "")}',
    'destination': f'~/Desktop/A股/审计交付版{VERSION}',
    'report': 'A股雷达六维全量审计与整改报告.docx',
    'preservation': {
        'expected_sha': '80ef5c2533fa541af0a02a6d443ec3b7275d21b47147e2cfe55c67dd34263fcb',
        'expected_count': 1601,
    },
    'fiveRoundsRequired': False,
    'evidenceSelection': f'artifacts/six-dimension-audit-{VERSION.replace(".", "")}/evidence-selection.json',
    'readme': f'''A股雷达趋势版 {VERSION} · 六维审计整改版

双击本目录中的 A股雷达趋势版.app 使用。此前版本、源码和报告继续保留。
各版本沿用同一本机资料，请先正常退出正在运行的版本，再打开另一个版本。

本版逐项核验六维审计发现，修复并验证系统稳定性、行情规则、量化回测、前端视图、模拟交易和构建发布门禁。
无法复现或判断不适用的审计项、验证证据及剩余风险见Word报告和交付验证记录。
''',
}

if __name__ == '__main__':
    run_path(str(Path(__file__).with_name('deliver-module-polish.py')),
             init_globals={'DELIVERY_PROFILE': PROFILE}, run_name='__main__')
