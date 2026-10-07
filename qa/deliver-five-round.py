"""Deliver version 1.5.3 without replacing any earlier desktop artifact."""
from pathlib import Path
from runpy import run_path

PROFILE = {
    'version': '1.5.3',
    'checks': 'artifacts/five-round-audit-20261001',
    'destination': '/Users/fengjinwen/Desktop/a股/五轮审计版1.5.3',
    'report': '三方五轮全链路审计报告.docx',
    'preservation': {'expected_sha': '80ef5c2533fa541af0a02a6d443ec3b7275d21b47147e2cfe55c67dd34263fcb', 'expected_count': 1601},
    'fiveRoundsRequired': True,
    'evidenceSelection': 'artifacts/five-round-audit-20261001/evidence-selection.json',
    'readme': '''A股雷达趋势版 1.5.3

双击本目录的 A股雷达趋势版.app。旧版本及此前成品继续保留。
各版本沿用同一本机资料，请先正常退出正在使用的版本，再打开另一版本。

本次进行了至少五轮三方全链路审计，修复搜索竞态、记录恢复、取消边界、构建与发布验证等问题。
策略评分、阈值和预设参数保持兼容。逐项问题、风险等级及实际回归结果见Word报告。

交付验证记录.json与审计验证证据.zip保存五轮报告及复现、整改、复验记录。
真实凭据连接、系统钥匙串授权、全市场扫描、长时间压力测试、Windows/Linux原生运行未执行。

源码不含node_modules、个人凭据或真实观察池文件。准备锁定依赖后可运行 pnpm verify:fullstack。
浏览器回归需要Chrome，可设置QA_CHROMIUM_PATH。依赖审计服务异常会阻断正式发布。
证据包可解压到源码根目录复核。ZIP逐文件校验；不承诺跨环境构建字节完全相同。
'''
}

if __name__ == '__main__':
    run_path(str(Path(__file__).with_name('deliver-module-polish.py')),
             init_globals={'DELIVERY_PROFILE': PROFILE}, run_name='__main__')
