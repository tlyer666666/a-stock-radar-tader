"use strict";

function expectedWindowControls(platform = process.platform) {
  return platform !== "darwin";
}

function assertTypography(chrome) {
  if (!/Segoe UI|Microsoft YaHei|PingFang SC|Noto Sans CJK SC|Noto Sans SC/i.test(chrome.bodyFont)) {
    throw new Error(`Unexpected desktop font stack: ${chrome.bodyFont}`);
  }
  if (chrome.navFontSize < 12 || chrome.navFontSize > 14) {
    throw new Error(`Navigation typography is outside the compact desktop scale: ${chrome.navFontSize}px`);
  }
  if (chrome.headingFontSize < 15 || chrome.headingFontSize > 24) {
    throw new Error(`Page heading is outside the responsive desktop scale: ${chrome.headingFontSize}px`);
  }
  if (chrome.navGroupCount !== 3) {
    throw new Error(`Expected three navigation groups, received ${chrome.navGroupCount}`);
  }
}

function assertWindowChrome(platform, chrome) {
  if (!expectedWindowControls(platform)) {
    if (chrome.controls) throw new Error("macOS must use native traffic lights");
    return;
  }
  if (
    !chrome.controls ||
    chrome.controls.width < 120 ||
    chrome.controls.height < 28 ||
    chrome.controls.height > 40
  ) {
    throw new Error(`Window controls are not correctly sized: ${JSON.stringify(chrome.controls)}`);
  }
}

function assertInformationCenter(module) {
  if (module.title !== "资讯中心") {
    throw new Error(`Information-center title mismatch: ${module.title}`);
  }
  if (module.contentType !== "announcement") {
    throw new Error(`Announcement route did not activate: ${module.contentType}`);
  }
  if (module.scopeCount !== 6 || !module.hasImportanceFilters) {
    throw new Error(`Announcement filters are incomplete: ${JSON.stringify(module)}`);
  }
  if (module.sourceCount > 2) {
    throw new Error(`Announcement module exposed unrelated news sources: ${module.sourceCount}`);
  }
}

function assertMinimumLayout(platform, layout) {
  if (layout.navigationOverflow) {
    throw new Error(`Minimum-size navigation overflows: ${JSON.stringify(layout)}`);
  }
  if (!layout.statusVisible) {
    throw new Error(`Minimum-size status bar is hidden: ${JSON.stringify(layout)}`);
  }
  if (expectedWindowControls(platform) && !layout.controlsVisible) {
    throw new Error(`Minimum-size window controls are clipped: ${JSON.stringify(layout)}`);
  }
}

module.exports = {
  assertInformationCenter,
  assertMinimumLayout,
  assertTypography,
  assertWindowChrome,
  expectedWindowControls
};
