const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const app = express();
// 云平台（Render / Fly.io / 阿里云等）会通过环境变量注入端口；本地默认 3210
const PORT = process.env.PORT || 3210;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ======================== 工具函数 ========================

function normalizeUrl(input) {
  let url = input.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    url = 'http://' + url;
  }
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// 取得剔除脚本/样式后的可见正文（用于文本与联系方式分析）
function getVisibleText($) {
  const clone = $('body').clone();
  clone.find('script, style, noscript').remove();
  return clone.text();
}

// ======================== 维度定义（权重合计 100 分）=======================
const DIMENSIONS = [
  { key: 'perf',        name: '页面加载性能',       icon: '⚡',  weight: 15 },
  { key: 'form',        name: '转化表单组件',       icon: '📋', weight: 10 },
  { key: 'contact',     name: '联系方式触达',       icon: '📞', weight: 10 },
  { key: 'product',     name: '产品/服务核心介绍',  icon: '📦', weight: 20 },
  { key: 'marketing',   name: '营销匹配度',         icon: '🎯', weight: 10 },
  { key: 'trust',       name: '信任背书体系',       icon: '🛡️', weight: 12 },
  { key: 'cta',         name: 'CTA行动号召',        icon: '🚀', weight: 8  },
  { key: 'layout',      name: '页面逻辑&内容排版',  icon: '📐', weight: 6  },
  { key: 'mobile',      name: '移动端适配体验',     icon: '📱', weight: 5  },
  { key: 'compliance',  name: '合规&干扰项',        icon: '✅', weight: 4  }
];

// ======================== 维度一：页面加载性能（15分）=======================
function analyzePerf(timing, headers, $, htmlLength) {
  const findings = [];
  let score = 0;

  const responseTime = timing.responseTime;
  const pageSize = htmlLength;
  const resourceCount = $('img, script, link[rel="stylesheet"], iframe').length;
  const blockingResources = $('head script:not([async]):not([defer]), head link[rel="stylesheet"]').length;
  const imgCount = $('img').length;
  const imgLazy = $('img[loading="lazy"], img[class*="lazy"], [class*="lazyload"]').length;
  const imgWithoutAlt = $('img:not([alt])').length;

  // 1) 首屏 LCP / 加载时长（近似用响应时间）：40 分
  let s1 = 0;
  if (responseTime < 800) s1 = 40;
  else if (responseTime < 1500) s1 = 32;
  else if (responseTime < 3000) s1 = 22;
  else if (responseTime < 5000) s1 = 12;
  else s1 = 4;
  score += s1;
  findings.push({
    item: '首屏加载时长(LCP近似)',
    value: responseTime + ' ms',
    status: responseTime < 800 ? 'good' : responseTime < 3000 ? 'fair' : 'poor',
    detail: responseTime < 800 ? '响应迅速，付费流量跳出风险低' : responseTime < 3000 ? '响应一般，仍有优化空间' : '响应较慢，付费流量极易高跳出'
  });

  // 2) 页面体积（间接反映图片压缩）：20 分
  let s2 = 0;
  if (pageSize < 100 * 1024) s2 = 20;
  else if (pageSize < 300 * 1024) s2 = 16;
  else if (pageSize < 800 * 1024) s2 = 10;
  else if (pageSize < 2 * 1024 * 1024) s2 = 5;
  else s2 = 2;
  score += s2;
  findings.push({
    item: 'HTML页面体积',
    value: formatSize(pageSize),
    status: pageSize < 300 * 1024 ? 'good' : pageSize < 1024 * 1024 ? 'fair' : 'poor',
    detail: pageSize < 300 * 1024 ? '体积适中' : pageSize < 1024 * 1024 ? '体积偏大，建议压缩图片与资源' : '体积过大，严重影响加载速度'
  });

  // 3) 无用 JS/CSS 资源冗余：15 分
  let s3 = 0;
  if (resourceCount < 15) s3 = 15;
  else if (resourceCount < 30) s3 = 12;
  else if (resourceCount < 50) s3 = 7;
  else if (resourceCount < 100) s3 = 3;
  else s3 = 1;
  score += s3;
  findings.push({
    item: '页面资源冗余度',
    value: resourceCount + ' 个 (JS:' + $('script').length + ' CSS:' + $('link[rel="stylesheet"]').length + ' IMG:' + imgCount + ')',
    status: resourceCount < 30 ? 'good' : resourceCount < 50 ? 'fair' : 'poor',
    detail: resourceCount < 30 ? '资源数量合理' : resourceCount < 50 ? '资源偏多，建议合并静态资源' : '资源过多，大量请求拖慢加载'
  });

  // 4) 白屏 / 阻塞资源：10 分
  let s4 = 0;
  if (blockingResources <= 2) s4 = 10;
  else if (blockingResources <= 5) s4 = 7;
  else if (blockingResources <= 10) s4 = 4;
  else s4 = 2;
  score += s4;
  findings.push({
    item: '头部阻塞资源(白屏风险)',
    value: blockingResources + ' 个',
    status: blockingResources <= 5 ? 'good' : 'poor',
    detail: blockingResources <= 5 ? '阻塞资源较少，白屏风险低' : '头部阻塞资源过多，建议JS添加defer/async或移至底部'
  });

  // 5) 图片懒加载 / alt 配置：15 分
  let s5 = 0;
  if (imgCount === 0) {
    s5 = 10; // 无图，无懒加载压力
  } else {
    if (imgLazy >= Math.ceil(imgCount / 2)) s5 += 9;
    else if (imgLazy > 0) s5 += 5;
    if (imgWithoutAlt === 0) s5 += 6;
    else s5 += 3;
  }
  score += s5;
  if (imgCount > 0) {
    findings.push({
      item: '图片懒加载 & alt',
      value: '懒加载 ' + imgLazy + '/' + imgCount + ' · 缺alt ' + imgWithoutAlt,
      status: imgLazy > 0 && imgWithoutAlt === 0 ? 'good' : imgWithoutAlt > 0 ? 'poor' : 'fair',
      detail: imgLazy === 0 ? '未检测到懒加载配置，非首屏图片建议加 loading="lazy"' : '已配置懒加载；' + (imgWithoutAlt > 0 ? imgWithoutAlt + '张图片缺少alt属性' : 'alt属性完整')
    });
  }

  const suggestions = [];
  if (responseTime >= 1500) suggestions.push('🔴 首屏加载偏慢，付费流量跳出高：建议CDN加速、页面缓存、升级服务器');
  if (pageSize >= 800 * 1024) suggestions.push('🔴 页面体积过大：压缩图片(WebP)、开启Gzip、精简冗余代码');
  if (resourceCount >= 50) suggestions.push('🟡 资源过多：合并CSS/JS、移除无用第三方库');
  if (blockingResources > 5) suggestions.push('🟡 阻塞资源多：给JS加defer/async、内联关键CSS');
  if (imgCount > 0 && imgLazy === 0) suggestions.push('🟡 图片未懒加载：非首屏图加 loading="lazy" 提升首屏速度');
  if (suggestions.length === 0) suggestions.push('✅ 页面加载性能良好，建议持续监控');

  return { score: Math.min(100, Math.round(score)), findings, suggestions };
}

// ======================== 维度二：转化表单组件（10分）=======================
function analyzeForm($) {
  const findings = [];
  let score = 0;

  const forms = $('form');
  const formCount = forms.length;
  let totalInputs = 0;
  let noAction = 0;
  forms.each((i, el) => {
    const inputs = $(el).find('input, select, textarea');
    totalInputs += inputs.length;
    if (!$(el).attr('action')) noAction++;
  });

  // 1) 表单存在且在合理位置：25 分
  if (formCount > 0) {
    score += 25;
    findings.push({
      item: '留资表单',
      value: formCount + ' 个表单 / ' + totalInputs + ' 个字段',
      status: 'good',
      detail: '核心留资出口存在；建议表单置于首屏或第二屏，用户无需过度滚动即可看到'
    });
  } else {
    findings.push({
      item: '留资表单',
      value: '0 个',
      status: 'poor',
      detail: '未检测到表单，用户无法在线提交信息，落地页核心转化出口缺失'
    });
  }

  // 2) 字段精简无冗余：20 分
  if (formCount > 0) {
    let s2 = 0;
    if (totalInputs > 0 && totalInputs <= 6) s2 = 20;
    else if (totalInputs <= 9) s2 = 14;
    else s2 = 6;
    score += s2;
    findings.push({
      item: '字段精简度',
      value: totalInputs + ' 个输入字段',
      status: totalInputs > 0 && totalInputs <= 6 ? 'good' : totalInputs <= 9 ? 'fair' : 'poor',
      detail: totalInputs > 9 ? '字段偏多易劝退用户，建议只保留姓名/电话/需求等核心字段' : '字段数量合理'
    });
  }

  // 3) 提交按钮醒目可点击：20 分
  const buttons = $('button, input[type="submit"], input[type="button"], [class*="btn"], [class*="button"], a.btn, a.button');
  if (buttons.length > 0) {
    score += 20;
    findings.push({ item: '提交按钮', value: buttons.length + ' 个按钮', status: 'good', detail: '检测到可点击按钮元素' });
  } else {
    findings.push({ item: '提交按钮', value: '0 个', status: 'poor', detail: '未检测到醒目提交按钮，建议增加视觉突出的CTA按钮' });
  }

  // 4) 表单可提交（action 配置）：20 分
  if (formCount > 0) {
    let s4 = noAction === 0 ? 20 : 8;
    score += s4;
    findings.push({
      item: '表单提交配置',
      value: noAction === 0 ? '均配置action' : noAction + '/' + formCount + ' 缺少action',
      status: noAction === 0 ? 'good' : 'poor',
      detail: noAction === 0 ? '表单可正常提交到后端' : noAction + '个表单未配置action，可能无法正常提交'
    });
  }

  // 5) 提交反馈 / 防重复提交：15 分（启发式：有提交按钮视为具备反馈机制，防重复需人工确认）
  if (formCount > 0 && buttons.length > 0) {
    score += 15;
    findings.push({
      item: '提交反馈 & 防重复',
      value: '需人工确认',
      status: 'fair',
      detail: '提示：请确认提交后有成功/失败反馈，并对提交按钮做防重复提交(置灰/loading)处理'
    });
  }

  const suggestions = [];
  if (formCount === 0) suggestions.push('🔴 缺少表单，强烈建议添加在线咨询/预约/留资表单，这是核心转化出口');
  if (formCount > 0 && totalInputs > 9) suggestions.push('🔴 表单字段过多，建议精简到姓名/电话/需求等核心字段');
  if (buttons.length === 0) suggestions.push('🔴 缺少醒目提交按钮，建议使用对比色突出显示');
  if (noAction > 0) suggestions.push('🔴 ' + noAction + '个表单缺少action，请确保能正确提交');
  if (formCount > 0) suggestions.push('🟡 请人工确认提交反馈与防重复提交(按钮置灰/loading)是否到位');
  if (suggestions.length === 0) suggestions.push('✅ 转化表单配置完善，建议持续A/B测试字段与按钮文案');

  return { score: Math.min(100, Math.round(score)), findings, suggestions };
}

// ======================== 维度三：联系方式触达（10分）=======================
function analyzeContact($) {
  const findings = [];
  let score = 0;
  const pageText = getVisibleText($);

  // 电话号码检测（可见文本 + tel: 链接 + 归一化校验）
  const phoneRawRegex = [
    /(?:\+?86[-\s]?)?(?:400|800)[-\s.]?(\d{3,4})[-\s.]?(\d{4})/g,
    /(?:\+?86[-\s]?)?1[3-9]\d[-\s.]?\d{4}[-\s.]?\d{4}/g,
    /\(?0\d{2,3}\)?[-\s.]?\d{3,4}[-\s.]?\d{3,4}/g
  ];
  const rawPhones = [];
  phoneRawRegex.forEach(p => { const m = pageText.match(p); if (m) m.forEach(s => rawPhones.push(s.trim())); });
  $('a[href^="tel:"]').each((i, el) => { const h = ($(el).attr('href') || '').replace(/^tel:/i, '').trim(); if (h) rawPhones.push(h); });

  const phones = new Set();
  rawPhones.forEach(raw => {
    let d = raw.replace(/[^\d]/g, '');
    if (d.startsWith('86') && d.length === 13) d = d.slice(2);
    if (/^1[3-9]\d{9}$/.test(d)) phones.add(d);
    else if (/^(400|800)\d{7}$/.test(d)) phones.add(d);
    else if (/^0\d{9,11}$/.test(d) && !/^0{10,12}$/.test(d)) phones.add(d);
  });
  const telLinks = $('a[href^="tel:"]').length;

  // 1) 电话 / 在线咨询入口存在：30 分
  if (phones.size > 0) {
    score += 30;
    const has400 = [...phones].some(p => p.startsWith('400') || p.startsWith('800'));
    findings.push({
      item: '联系电话',
      value: phones.size + ' 个' + (has400 ? '(含400)' : ''),
      status: has400 ? 'good' : 'fair',
      detail: has400 ? '检测到400/800电话，专业度高，增强信任' : '检测到电话，建议用400电话统一对外形象'
    });
  } else {
    findings.push({ item: '联系电话', value: '未检测到', status: 'poor', detail: '未检测到任何电话号码，用户无法电话联系' });
  }

  // 2) 一键拨号：15 分
  let s2 = telLinks > 0 ? 15 : (phones.size > 0 ? 7 : 0);
  score += s2;
  findings.push({
    item: '一键拨号',
    value: telLinks > 0 ? telLinks + ' 个tel链接' : '未配置',
    status: telLinks > 0 ? 'good' : phones.size > 0 ? 'fair' : 'poor',
    detail: telLinks > 0 ? '已配置 tel: 一键拨号，移动端体验好' : '建议为电话添加 tel: 链接，移动端一键拨打'
  });

  // 3) 悬浮常驻入口：15 分
  const floatEls = $('[class*="float"], [class*="fixed"], [class*="suspend"], [class*="popup"], [class*="consult"], [class*="kefu"], [id*="float"], [id*="suspend"], [id*="kefu"]');
  let s3 = floatEls.length > 0 ? 15 : 0;
  score += s3;
  findings.push({
    item: '悬浮常驻咨询入口',
    value: floatEls.length > 0 ? floatEls.length + ' 个' : '未检测到',
    status: floatEls.length > 0 ? 'good' : 'fair',
    detail: floatEls.length > 0 ? '检测到悬浮/固定咨询组件，用户随时可联系' : '建议添加右侧悬浮咨询按钮或在线客服窗口'
  });

  // 4) 微信 / QQ 即时通讯：20 分
  const qq = pageText.match(/QQ[\s:：]*\d{5,12}/gi);
  const wechat = pageText.match(/(?:微信|微信号|wechat|weixin)[\s:：]*[a-zA-Z0-9_-]{4,30}/gi);
  const qqGroup = pageText.match(/(?:QQ群|加群)[\s:：]*\d{5,12}/gi);
  if (qq || wechat || qqGroup) {
    score += 20;
    const ims = [];
    if (qq) ims.push('QQ'); if (wechat) ims.push('微信'); if (qqGroup) ims.push('QQ群');
    findings.push({ item: '微信/QQ即时通讯', value: ims.join('、'), status: 'good', detail: '检测到即时通讯方式，方便用户快速沟通' });
  } else {
    findings.push({ item: '微信/QQ即时通讯', value: '未检测到', status: 'fair', detail: '建议添加微信二维码/QQ客服，丰富转化通路' });
  }

  // 5) 联系我们入口：10 分
  const contactLinks = $('a').filter((i, el) => {
    const t = $(el).text().toLowerCase();
    const h = ($(el).attr('href') || '').toLowerCase();
    return t.includes('联系') || t.includes('contact') || h.includes('contact') || h.includes('lianxi');
  });
  let s5 = contactLinks.length > 0 ? 10 : 0;
  score += s5;
  findings.push({
    item: '联系我们入口',
    value: contactLinks.length > 0 ? contactLinks.length + ' 个链接' : '未检测到',
    status: contactLinks.length > 0 ? 'good' : 'fair',
    detail: contactLinks.length > 0 ? '检测到"联系我们"入口' : '建议在导航/页脚添加联系入口'
  });

  // 6) 真实有效佐证（邮箱/地址）：10 分
  const emails = new Set();
  const emailMatches = pageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  if (emailMatches) emailMatches.forEach(m => emails.add(m));
  let addressFound = false;
  const addrFeature = /(省|市|区|县|路|街|道|号|栋|楼|大厦|广场|园区)/;
  $('body *').each((i, el) => {
    if (addressFound) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
    const t = $(el).clone().children().remove().end().text().trim();
    if (!t || t.search(/地址|位于|办公地点/) === -1) return;
    if (/(网站|域名|邮箱|网址)/i.test(t)) return;
    if (!addrFeature.test(t)) return;
    addressFound = true;
  });
  let s6 = (emails.size > 0 ? 5 : 0) + (addressFound ? 5 : 0);
  score += s6;
  findings.push({
    item: '真实有效佐证',
    value: (emails.size > 0 ? '邮箱✓ ' : '') + (addressFound ? '地址✓' : '') || '缺失',
    status: (emails.size > 0 || addressFound) ? 'good' : 'fair',
    detail: (emails.size > 0 || addressFound) ? '检测到邮箱/实体地址，佐证联系方式真实有效' : '建议补充企业邮箱/公司地址，佐证联系方式真实'
  });

  const suggestions = [];
  if (phones.size === 0) suggestions.push('🔴 未检测到联系电话，强烈建议添加400电话或客服热线');
  if (telLinks === 0 && phones.size > 0) suggestions.push('🟡 建议为电话添加 tel: 一键拨号链接');
  if (floatEls.length === 0) suggestions.push('🟡 建议添加悬浮咨询按钮/在线客服，随时可联系');
  if (!qq && !wechat && !qqGroup) suggestions.push('🟡 建议添加微信/QQ客服或二维码');
  if (contactLinks.length === 0) suggestions.push('🟡 建议添加"联系我们"入口集中展示联系方式');
  if (!emails.size && !addressFound) suggestions.push('🟡 建议补充企业邮箱/实体地址佐证真实性');
  if (suggestions.length === 0) suggestions.push('✅ 联系方式触达完善，建议确保电话移动端可一键拨打');

  return { score: Math.min(100, Math.round(score)), findings, suggestions };
}

// ======================== 维度四：产品/服务核心介绍（20分）=======================
function analyzeProduct($) {
  const findings = [];
  let score = 0;

  const h1Count = $('h1').length;
  const h2Count = $('h2').length;
  const h3Count = $('h3').length;
  const bodyText = getVisibleText($).replace(/\s+/g, '');
  const textLength = bodyText.length;
  const imgCount = $('img').length;

  // 1) 首屏讲清提供什么（H1主标题）：15 分
  if (h1Count > 0) {
    score += 15;
    const h1Text = $('h1').first().text().trim();
    findings.push({ item: '首屏业务主张(H1)', value: (h1Text.substring(0, 30) || '(无文本)'), status: 'good', detail: '检测到H1主标题，用户可快速识别你提供什么产品/服务' });
  } else {
    findings.push({ item: '首屏业务主张(H1)', value: '未检测到', status: 'poor', detail: '缺少H1主标题，用户无法快速识别页面核心业务' });
  }

  // 2) 文本量（介绍完整度）：15 分
  let s2 = 0;
  if (textLength > 1000) s2 = 15;
  else if (textLength > 500) s2 = 11;
  else if (textLength > 200) s2 = 6;
  else s2 = 2;
  score += s2;
  findings.push({
    item: '内容介绍完整度',
    value: textLength + ' 字',
    status: textLength > 500 ? 'good' : textLength > 200 ? 'fair' : 'poor',
    detail: textLength > 500 ? '内容充实，能充分介绍产品' : textLength > 200 ? '内容偏少，建议补充详细描述' : '内容严重不足，用户无法了解产品'
  });

  // 3) 产品描述关键词（功能/方案/规格/优势/适用）：20 分
  const productKeywords = ['产品', '服务', '功能', '特点', '优势', '方案', '规格', '参数', '适用', '场景', '解决', '需求', '价值', '效果', '流程', '技术', '工艺', '认证', '保障', '承诺'];
  let kwCount = 0;
  const foundKw = [];
  productKeywords.forEach(kw => { if (bodyText.includes(kw)) { kwCount++; foundKw.push(kw); } });
  let s3 = 0;
  if (kwCount >= 6) s3 = 20;
  else if (kwCount >= 3) s3 = 13;
  else if (kwCount >= 1) s3 = 6;
  score += s3;
  findings.push({
    item: '产品核心关键词',
    value: kwCount + ' 类 (' + foundKw.slice(0, 6).join('、') + ')',
    status: kwCount >= 6 ? 'good' : kwCount >= 3 ? 'fair' : 'poor',
    detail: kwCount >= 3 ? '产品/方案/优势等描述较全面' : '产品描述关键词匮乏，建议补充功能、规格、优势等内容'
  });

  // 4) 标题层级（结构清晰）：10 分
  let s4 = (h2Count + h3Count) >= 2 ? 10 : (h2Count + h3Count) >= 1 ? 6 : 0;
  score += s4;
  if (h2Count + h3Count > 0) {
    findings.push({ item: '内容结构层级', value: 'H2:' + h2Count + ' H3:' + h3Count, status: h2Count >= 2 ? 'good' : 'fair', detail: h2Count >= 2 ? '标题层级清晰' : '建议增加H2分段标题组织卖点' });
  } else {
    findings.push({ item: '内容结构层级', value: '未检测到H2/H3', status: 'poor', detail: '缺少子标题层级，内容结构不清晰' });
  }

  // 5) 案例展示：15 分
  const caseKeywords = ['案例', '客户案例', '成功案例', '合作客户', '客户展示', '项目案例'];
  const hasCase = caseKeywords.some(kw => bodyText.includes(kw)) || $('[class*="case"]').length > 0;
  let s5 = hasCase ? 15 : 0;
  score += s5;
  findings.push({
    item: '案例展示',
    value: hasCase ? '已展示' : '未检测到',
    status: hasCase ? 'good' : 'fair',
    detail: hasCase ? '检测到案例内容，增强说服力' : '建议添加成功案例/合作客户展示'
  });

  // 6) 产品图片（视觉呈现）：15 分
  let s6 = 0;
  if (imgCount >= 3) s6 = 15;
  else if (imgCount >= 1) s6 = 9;
  score += s6;
  if (imgCount > 0) {
    findings.push({ item: '产品图片', value: imgCount + ' 张', status: imgCount >= 3 ? 'good' : 'fair', detail: imgCount >= 3 ? '图文并茂，视觉呈现好' : '图片较少，建议补充产品/场景图' });
  } else {
    findings.push({ item: '产品图片', value: '0 张', status: 'poor', detail: '纯文字页面缺乏视觉吸引力，建议添加产品图' });
  }

  // 7) 目标客户 / 痛点回应：10 分
  const painKeywords = ['您', '客户', '企业', '用户', '人群', '解决', '痛点', '困扰', '难题', '需求'];
  let painCount = 0;
  painKeywords.forEach(kw => { if (bodyText.includes(kw)) painCount++; });
  let s7 = painCount >= 3 ? 10 : painCount >= 1 ? 6 : 0;
  score += s7;
  findings.push({
    item: '目标客户 & 痛点回应',
    value: painCount >= 3 ? '明确' : painCount >= 1 ? '部分' : '缺失',
    status: painCount >= 3 ? 'good' : painCount >= 1 ? 'fair' : 'poor',
    detail: painCount >= 3 ? '页面回应了目标人群与痛点' : '建议明确目标客户群体并直击其搜索痛点'
  });

  const suggestions = [];
  if (h1Count === 0) suggestions.push('🔴 缺少H1主标题，建议3秒内让用户知道你提供什么');
  if (textLength < 500) suggestions.push('🔴 内容过少，建议补充功能、规格、应用场景、客户价值');
  if (kwCount < 3) suggestions.push('🟡 产品描述不全面，建议增加方案/优势/规格等内容');
  if (!hasCase) suggestions.push('🟡 建议添加客户成功案例增强说服力');
  if (imgCount === 0) suggestions.push('🔴 缺少图片，建议图文并茂');
  if (painCount < 3) suggestions.push('🟡 建议明确目标客户群体并直击其痛点');
  if (suggestions.length === 0) suggestions.push('✅ 产品核心介绍完整，建议定期更新保持新鲜度');

  return { score: Math.min(100, Math.round(score)), findings, suggestions };
}

// ======================== 维度五：营销匹配度（SEM专属，10分）=======================
// 需要用户填写"搜索关键词/广告创意"。未填写则按页面主题一致性近似评估并提示。
function analyzeMarketing($, opts) {
  const findings = [];
  const suggestions = [];
  const keyword = ((opts && opts.searchKeyword) || '').trim();
  const adText = ((opts && opts.adText) || '').trim();
  const bodyText = getVisibleText($).replace(/\s+/g, '');
  const h1 = ($('h1').first().text() || '').replace(/\s+/g, '');
  const title = ($('title').text() || '').replace(/\s+/g, '');
  const desc = ($('meta[name="description"]').attr('content') || '').replace(/\s+/g, '');
  const firstScreen = bodyText.substring(0, 1500);

  if (!keyword && !adText) {
    const biz = ['产品', '服务', '方案', '解决', '提供', '专业', '咨询', '报价', '价格', '免费'];
    const hit = biz.filter(w => firstScreen.includes(w)).length;
    let score = hit >= 3 ? 72 : hit >= 1 ? 60 : 45;
    findings.push({ item: '匹配度评估依据', value: '未提供搜索词', status: 'fair', detail: '未填写搜索关键词/广告创意，采用页面自身主题一致性近似评估' });
    findings.push({ item: '首屏主题明确度', value: h1 ? '有H1' : '无H1', status: h1 ? 'good' : 'poor', detail: h1 ? ('首屏主标题：' + h1.substring(0, 30)) : '缺少H1主标题，主题不明确' });
    suggestions.push('🟡 建议在输入框填写"搜索关键词/广告创意"，以获得SEM搜索词与落地页的精准匹配度评分');
    if (!h1) suggestions.push('🔴 首屏缺少H1主标题，SEM流量无法快速识别业务主题');
    return { score, findings, suggestions };
  }

  // 候选词：从搜索词+广告词中抽取2-4字中文片段，过滤停用/疑问词
  const stop = ['怎么', '如何', '哪家', '多少', '什么', '哪里', '哪个', '最好', '推荐', '靠谱', '一下', '我们', '你们', '他们', '可以', '提供', '服务', '专业', '咨询', '一个'];
  const clean = (keyword + ' ' + adText).replace(/[^\u4e00-\u9fa5]/g, '');
  const candidates = [];
  for (let i = 0; i < clean.length; i++) {
    for (let len = 2; len <= 4 && i + len <= clean.length; len++) {
      const w = clean.substring(i, i + len);
      if (!stop.includes(w)) candidates.push(w);
    }
  }
  const uniq = [...new Set(candidates)];
  let firstHit = 0, fullHit = 0, hitWords = [];
  uniq.forEach(w => {
    if (w.length < 2) return;
    if (firstScreen.includes(w)) firstHit++;
    if (bodyText.includes(w)) { fullHit++; hitWords.push(w); }
  });
  const totalCand = uniq.length || 1;
  const firstRatio = firstHit / totalCand;
  const fullRatio = fullHit / totalCand;

  // 评分：首屏回应40 + 全页覆盖25 + 创意对应20 + 无错配15
  let s1 = firstRatio >= 0.5 ? 40 : firstRatio >= 0.25 ? 28 : firstRatio > 0 ? 14 : 0;
  let s2 = fullRatio >= 0.5 ? 25 : fullRatio >= 0.25 ? 18 : fullRatio > 0 ? 8 : 0;
  let s3 = 0;
  if (adText) {
    const adClean = adText.replace(/[^\u4e00-\u9fa5]/g, '');
    let adHit = 0, adLen = 0;
    for (let i = 0; i < adClean.length; i++) {
      const w = adClean.substring(i, i + 2);
      if (stop.includes(w)) continue;
      adLen++; if (bodyText.includes(w)) adHit++;
    }
    s3 = adLen ? Math.round(20 * adHit / adLen) : 10;
  } else s3 = 10;
  let s4 = (fullRatio > 0 || firstRatio > 0) ? 15 : 0; // 完全不命中视为可能错配
  const score = Math.min(100, s1 + s2 + s3 + s4);

  findings.push({
    item: '搜索词首屏回应',
    value: Math.round(firstRatio * 100) + '% 命中首屏',
    status: firstRatio >= 0.5 ? 'good' : firstRatio >= 0.25 ? 'fair' : 'poor',
    detail: firstRatio >= 0.25 ? '搜索词核心诉求在首屏得到回应' : '搜索词未在首屏(标题/H1/首段)体现，流量易错配流失'
  });
  findings.push({
    item: '搜索词全页覆盖',
    value: Math.round(fullRatio * 100) + '% 命中 (' + hitWords.slice(0, 5).join('、') + ')',
    status: fullRatio >= 0.5 ? 'good' : fullRatio >= 0.25 ? 'fair' : 'poor',
    detail: fullRatio > 0 ? '落地页内容与搜索词相关' : '落地页几乎不含搜索词相关内容'
  });
  if (adText) {
    findings.push({ item: '广告创意对应', value: s3 >= 14 ? '高度对应' : s3 >= 8 ? '部分对应' : '弱对应', status: s3 >= 14 ? 'good' : s3 >= 8 ? 'fair' : 'poor', detail: '广告创意文案与落地页内容对应度' });
  }
  findings.push({
    item: '业务错配风险',
    value: (fullRatio > 0 || firstRatio > 0) ? '低' : '高',
    status: (fullRatio > 0 || firstRatio > 0) ? 'good' : 'poor',
    detail: (fullRatio > 0 || firstRatio > 0) ? '暂未发现明显"搜A推B"错配' : '搜索词与页面内容完全不相关，存在严重业务错配'
  });

  if (firstRatio < 0.25) suggestions.push('🔴 搜索词未在首屏体现，建议首屏标题/首段直接回应搜索词核心诉求');
  if (fullRatio < 0.25) suggestions.push('🔴 落地页内容与搜索词脱节，建议围绕搜索词重构页面主题，避免错配');
  if (adText && s3 < 8) suggestions.push('🟡 广告创意与落地页内容不一致，建议落地页呼应创意标题/卖点');
  if (suggestions.length === 0) suggestions.push('✅ 搜索词与落地页匹配度良好，可继续优化首屏关键词密度');

  return { score, findings, suggestions };
}

// ======================== 维度六：信任背书体系（12分）=======================
function analyzeTrust($) {
  const findings = [];
  let score = 0;
  const bodyText = getVisibleText($).replace(/\s+/g, '');

  // 1) 项目/客户案例：20 分
  const caseKw = ['案例', '客户案例', '成功案例', '合作客户', '客户展示', '项目案例', '客户名单'];
  const hasCase = caseKw.some(kw => bodyText.includes(kw)) || $('[class*="case"], [class*="customer"], [class*="client"]').length > 0;
  let s1 = hasCase ? 20 : 0;
  score += s1;
  findings.push({ item: '项目/客户案例', value: hasCase ? '已展示' : '未检测到', status: hasCase ? 'good' : 'fair', detail: hasCase ? '真实案例增强说服力' : '建议添加成功案例/合作客户' });

  // 2) 企业资质 / 证书：25 分
  const qualKw = ['资质', '证书', '认证', 'ISO', '专利', '许可', '荣誉', '奖章', '授权', '高新', '商标'];
  const hasQual = qualKw.some(kw => bodyText.includes(kw)) || $('[class*="certif"], [class*="award"], [class*="honor"], [class*="qualification"], [class*="license"]').length > 0;
  let s2 = hasQual ? 25 : 0;
  score += s2;
  findings.push({ item: '企业资质/证书', value: hasQual ? '已展示' : '未检测到', status: hasQual ? 'good' : 'fair', detail: hasQual ? '检测到资质/认证/荣誉，提升专业度' : '建议展示企业资质、认证、荣誉奖项' });

  // 3) 客户评价 / 口碑：25 分
  const reviewKw = ['评价', '口碑', '好评', '满意', '反馈', '推荐', '用户说', 'testimonial', 'review', '评分', '星'];
  const hasReview = reviewKw.some(kw => bodyText.toLowerCase().includes(kw.toLowerCase())) || $('[class*="review"], [class*="comment"], [class*="testimonial"]').length > 0;
  let s3 = hasReview ? 25 : 0;
  score += s3;
  findings.push({ item: '客户评价/口碑', value: hasReview ? '已展示' : '未检测到', status: hasReview ? 'good' : 'fair', detail: hasReview ? '检测到客户评价/口碑佐证' : '建议添加客户好评、评分、口碑展示' });

  // 4) 售后 / 质保 / 服务保障承诺：20 分
  const afterKw = ['售后', '质保', '保修', '保障', '承诺', '服务承诺', '无忧', '退换', '三包', '赔付'];
  const hasAfter = afterKw.some(kw => bodyText.includes(kw));
  let s4 = hasAfter ? 20 : 0;
  score += s4;
  findings.push({ item: '售后/服务保障', value: hasAfter ? '已承诺' : '未检测到', status: hasAfter ? 'good' : 'fair', detail: hasAfter ? '检测到售后/质保/服务承诺' : '建议明确售后保障、质保承诺，降低决策顾虑' });

  // 5) 其他信任元素（ICP备案/版权/品牌）：10 分
  const hasIcp = bodyText.includes('ICP') || $('a[href*="beian"]').length > 0;
  const hasCopyright = bodyText.includes('版权') || bodyText.includes('©') || bodyText.includes('Copyright');
  const hasBrand = $('[class*="partner"], [class*="brand"], [class*="logo"]').length > 0;
  let extra = (hasIcp ? 4 : 0) + (hasCopyright ? 3 : 0) + (hasBrand ? 3 : 0);
  let s5 = Math.min(10, extra);
  score += s5;
  const extraList = [];
  if (hasIcp) extraList.push('ICP备案'); if (hasCopyright) extraList.push('版权信息'); if (hasBrand) extraList.push('品牌标识');
  findings.push({ item: '基础信任元素', value: extraList.length ? extraList.join('、') : '缺失', status: extraList.length ? 'good' : 'fair', detail: extraList.length ? '检测到基础信任元素' : '建议补充ICP备案号、版权信息、品牌标识' });

  const suggestions = [];
  if (!hasCase) suggestions.push('🟡 建议添加真实客户案例/合作客户展示');
  if (!hasQual) suggestions.push('🟡 建议展示企业资质、认证证书、荣誉奖项');
  if (!hasReview) suggestions.push('🟡 建议添加客户评价、评分、口碑佐证');
  if (!hasAfter) suggestions.push('🟡 建议明确售后保障/质保承诺，降低顾虑');
  if (!extraList.length) suggestions.push('🟡 建议补充ICP备案、版权信息、品牌标识');
  if (suggestions.length === 0) suggestions.push('✅ 信任背书体系完善，建议用真实数据持续强化');

  return { score: Math.min(100, Math.round(score)), findings, suggestions };
}

// ======================== 维度七：CTA行动号召（8分）=======================
function analyzeCta($) {
  const findings = [];
  let score = 0;
  const bodyText = getVisibleText($).replace(/\s+/g, '');
  const lowerText = bodyText.toLowerCase();

  const ctaKeywords = ['立即咨询', '免费咨询', '在线咨询', '立即注册', '免费注册', '立即购买', '立即下单', '立即预约', '免费预约', '在线预约', '提交', '报名', '免费报名', '领取', '免费领取', '下载', '免费下载', '获取', '获取方案', '获取报价', '免费获取', '试听', '免费试听', '申请', '免费申请', '联系我们', '了解详情', '查看详情', '立即体验', '免费体验', '免费试用', '询价', '留言', '在线留言', '拨打电话', '电话咨询', '加微信', '扫码'];
  const foundCTAs = ctaKeywords.filter(kw => bodyText.includes(kw));
  const allLinks = $('a');
  let ctaLinkCount = 0;
  allLinks.each((i, el) => { const t = $(el).text().trim(); if (foundCTAs.some(k => t.includes(k))) ctaLinkCount++; });

  // 1) 关键位置布置转化按钮（首屏/案例后/底部）：30 分
  let s1 = ctaLinkCount >= 3 ? 30 : ctaLinkCount >= 1 ? 18 : 0;
  score += s1;
  findings.push({
    item: 'CTA按钮分布',
    value: ctaLinkCount + ' 个CTA链接',
    status: ctaLinkCount >= 3 ? 'good' : ctaLinkCount >= 1 ? 'fair' : 'poor',
    detail: ctaLinkCount >= 3 ? '首屏/文中/页尾多处布置，转化入口充足' : ctaLinkCount >= 1 ? 'CTA入口偏少，建议至少3处布置' : '缺少CTA按钮，用户无明确转化引导'
  });

  // 2) 营销化文案（不止"提交"）：30 分
  const valueWords = ['获取报价', '获取方案', '免费领取', '免费咨询', '立即咨询', '免费获取', '领取方案', '预约', '免费试用', '免费下载'];
  const hasValueCta = valueWords.some(w => bodyText.includes(w));
  const onlySubmit = foundCTAs.length > 0 && !hasValueCta;
  let s2 = hasValueCta ? 30 : foundCTAs.length > 0 ? 15 : 0;
  score += s2;
  findings.push({
    item: 'CTA文案营销化',
    value: hasValueCta ? '含价值型文案' : onlySubmit ? '仅"提交"类' : '无CTA',
    status: hasValueCta ? 'good' : foundCTAs.length > 0 ? 'fair' : 'poor',
    detail: hasValueCta ? '使用了"获取报价/领取方案"等价值型文案' : onlySubmit ? '建议把"提交"改为"获取报价/免费领取"等价值型文案' : '建议添加营销化CTA文案'
  });

  // 3) 按钮醒目存在（class含btn + 按钮元素）：25 分
  const btnEls = $('button, input[type="submit"], input[type="button"], [class*="btn"], [class*="button"]');
  let s3 = btnEls.length >= 2 ? 25 : btnEls.length === 1 ? 15 : 0;
  score += s3;
  findings.push({
    item: 'CTA按钮显眼度',
    value: btnEls.length + ' 个按钮元素',
    status: btnEls.length >= 2 ? 'good' : btnEls.length === 1 ? 'fair' : 'poor',
    detail: btnEls.length >= 2 ? '按钮元素充足' : '建议增加醒目CTA按钮，使用对比色突出'
  });

  // 4) 告知点击价值（营销文案即视为告知价值）：15 分
  let s4 = hasValueCta ? 15 : 0;
  score += s4;
  findings.push({
    item: '点击价值告知',
    value: hasValueCta ? '已告知' : '未告知',
    status: hasValueCta ? 'good' : 'fair',
    detail: hasValueCta ? 'CTA文案告知了用户点击后获得的价值' : '建议在按钮旁说明点击后可获得的价值(如免费方案)'
  });

  const suggestions = [];
  if (ctaLinkCount < 3) suggestions.push('🔴 CTA入口不足，建议首屏/案例后/页尾至少3处布置转化按钮');
  if (onlySubmit) suggestions.push('🔴 CTA文案过于平淡，建议改为"获取报价/免费领取方案"等价值型文案');
  if (btnEls.length < 2) suggestions.push('🟡 按钮不够醒目，建议使用对比色突出显示');
  if (!hasValueCta) suggestions.push('🟡 建议告知用户点击按钮可获得的价值');
  if (suggestions.length === 0) suggestions.push('✅ CTA行动号召配置良好，建议A/B测试文案与位置');

  return { score: Math.min(100, Math.round(score)), findings, suggestions };
}

// ======================== 维度八：页面逻辑&内容排版（6分）=======================
function analyzeLayout($) {
  const findings = [];
  let score = 0;
  const bodyText = getVisibleText($).replace(/\s+/g, '');
  const h2Count = $('h2').length;
  const h3Count = $('h3').length;

  // 1) 标题层级（信息层级）：35 分
  let s1 = (h2Count + h3Count) >= 4 ? 35 : (h2Count + h3Count) >= 2 ? 25 : (h2Count + h3Count) >= 1 ? 12 : 0;
  score += s1;
  findings.push({
    item: '信息层级结构',
    value: 'H2:' + h2Count + ' H3:' + h3Count,
    status: (h2Count + h3Count) >= 2 ? 'good' : 'fair',
    detail: (h2Count + h3Count) >= 2 ? '标题层级清晰，信息有秩序' : '标题层级偏少，建议用H2/H3组织内容板块'
  });

  // 2) 无大段密集堆砌（分段清晰）：30 分
  let maxPara = 0;
  $('p, div').each((i, el) => {
    const t = $(el).clone().children().remove().end().text().trim();
    if (t.length > maxPara) maxPara = t.length;
  });
  let s2 = maxPara < 150 ? 30 : maxPara < 300 ? 20 : maxPara < 500 ? 10 : 4;
  score += s2;
  findings.push({
    item: '段落分段清晰度',
    value: '最长单段 ' + maxPara + ' 字',
    status: maxPara < 300 ? 'good' : maxPara < 500 ? 'fair' : 'poor',
    detail: maxPara < 300 ? '文字分段清晰，阅读流畅' : '存在大段密集文本，建议拆分成短段落/列表'
  });

  // 3) 叙事逻辑（痛点→方案→优势→案例）：35 分
  const seq = ['痛点', '方案', '优势', '案例'];
  const positions = seq.map(k => bodyText.indexOf(k));
  let ordered = 0;
  for (let i = 0; i < positions.length - 1; i++) {
    if (positions[i] !== -1 && positions[i + 1] !== -1 && positions[i] < positions[i + 1]) ordered++;
  }
  const hasAll = positions.every(p => p !== -1);
  let s3 = hasAll ? (ordered >= 3 ? 35 : ordered >= 2 ? 22 : 12) : (ordered >= 1 ? 10 : 0);
  score += s3;
  findings.push({
    item: '叙事逻辑顺序',
    value: hasAll ? (ordered >= 3 ? '逻辑通顺' : '部分乱序') : '关键词不全',
    status: hasAll && ordered >= 3 ? 'good' : 'fair',
    detail: hasAll && ordered >= 3 ? '呈现"痛点→方案→优势→案例"通顺逻辑' : '建议按"痛点→方案→优势→案例→转化"组织叙事'
  });

  const suggestions = [];
  if ((h2Count + h3Count) < 2) suggestions.push('🟡 建议用H2/H3将内容分为"产品特点/应用场景/客户案例"等板块');
  if (maxPara >= 500) suggestions.push('🔴 存在大段密集文本，建议拆分为短段落、列表、小标题提升可读性');
  if (!hasAll || ordered < 3) suggestions.push('🟡 建议按"痛点→方案→优势→案例→转化"组织叙事逻辑');
  if (suggestions.length === 0) suggestions.push('✅ 页面逻辑与排版清晰，阅读流畅');

  return { score: Math.min(100, Math.round(score)), findings, suggestions };
}

// ======================== 维度九：移动端适配体验（5分）=======================
function analyzeMobile($) {
  const findings = [];
  let score = 0;

  // 1) viewport meta：40 分
  const viewport = $('meta[name="viewport"]').attr('content') || '';
  const hasViewport = /width\s*=\s*device-width/i.test(viewport) || /initial-scale/i.test(viewport);
  let s1 = hasViewport ? 40 : 0;
  score += s1;
  findings.push({
    item: '移动端viewport',
    value: hasViewport ? '已配置' : '缺失',
    status: hasViewport ? 'good' : 'poor',
    detail: hasViewport ? '已配置响应式视口' : '缺少 viewport meta，移动端可能缩放异常'
  });

  // 2) 响应式媒体查询：30 分
  const styleText = $('style').text() + ($('link[rel="stylesheet"]').length > 0 ? ' has-css' : '');
  const hasMedia = /@media/.test(styleText) || /max-width/.test(styleText);
  let s2 = hasMedia ? 30 : 0;
  score += s2;
  findings.push({
    item: '响应式适配',
    value: hasMedia ? '检测到媒体查询' : '未检测到',
    status: hasMedia ? 'good' : 'fair',
    detail: hasMedia ? '检测到 @media/ max-width 响应式规则' : '未检测到响应式CSS，建议针对移动端断点适配'
  });

  // 3) 触控友好（按钮尺寸/输入类型）：30 分
  const telInputs = $('input[type="tel"]').length;
  const buttons = $('button, a.btn, [class*="btn"], input[type="submit"]').length;
  let s3 = 0;
  if (buttons >= 2 && telInputs >= 0) s3 = 20;
  if (telInputs > 0) s3 += 10; // 电话拨号友好
  score += s3;
  findings.push({
    item: '触控 & 输入友好',
    value: buttons + ' 按钮' + (telInputs > 0 ? ' · 含tel输入' : ''),
    status: buttons >= 2 ? 'good' : 'fair',
    detail: buttons >= 2 ? '按钮元素充足，移动端可点击' : '建议保证按钮尺寸适合手指触控，避免误触'
  });

  const suggestions = [];
  if (!hasViewport) suggestions.push('🔴 缺少 viewport meta，移动端排版会错乱');
  if (!hasMedia) suggestions.push('🟡 未检测到响应式CSS，建议增加移动端断点适配');
  if (buttons < 2) suggestions.push('🟡 移动端按钮偏小/偏少，建议增大点击区域避免误触');
  if (suggestions.length === 0) suggestions.push('✅ 移动端适配良好');

  return { score: Math.min(100, Math.round(score)), findings, suggestions };
}

// ======================== 维度十：合规&干扰项（4分）=======================
function analyzeCompliance($) {
  const findings = [];
  let score = 100; // 从满分反向扣分

  const bodyText = getVisibleText($).replace(/\s+/g, '');
  const lower = bodyText.toLowerCase();

  // 隐私提示：25 分（无则扣25）
  const hasPrivacy = lower.includes('隐私') || lower.includes('privacy') || $('a[href*="privacy"], a[href*="隐私"]').length > 0;
  if (hasPrivacy) {
    findings.push({ item: '隐私提示', value: '已提供', status: 'good', detail: '检测到隐私相关提示' });
  } else {
    score -= 25;
    findings.push({ item: '隐私提示', value: '缺失', status: 'poor', detail: '收集用户信息建议提供隐私提示/隐私政策，合规且提升信任' });
  }

  // 无虚假/极限宣传：30 分（命中极限词扣30）
  const limitWords = ['最', '第一', '国家级', '唯一', '顶级', '绝对', '史无前例', '100%', '全网', '极致', '王牌', '绝无仅有', '销量第一', '全国第一', '领导品牌'];
  const hitLimit = limitWords.filter(w => bodyText.includes(w));
  if (hitLimit.length === 0) {
    findings.push({ item: '宣传合规性', value: '无明显极限词', status: 'good', detail: '未发现夸大/虚假宣传极限词' });
  } else {
    score -= 30;
    findings.push({ item: '虚假/极限宣传', value: '命中 ' + hitLimit.length + ' 处', status: 'poor', detail: '检测到"' + hitLimit.slice(0, 4).join('、') + '"等极限词，存在虚假宣传风险，建议整改' });
  }

  // 无强制骚扰弹窗：25 分（检测到弹窗但关闭困难风险，提示需人工确认，扣25）
  const popupEls = $('[class*="popup"], [class*="modal"], [class*="dialog"], [class*="mask"], [id*="popup"], [id*="modal"]');
  if (popupEls.length === 0) {
    findings.push({ item: '强制弹窗', value: '未检测到', status: 'good', detail: '未检测到弹窗组件' });
  } else {
    score -= 25;
    findings.push({ item: '强制弹窗', value: popupEls.length + ' 个弹窗组件', status: 'fair', detail: '检测到弹窗组件，请人工确认是否"关闭困难/强制骚扰"，建议提供明显关闭按钮且非强制' });
  }

  // 无大量外链跳出：20 分（外链过多扣20）
  const extLinks = $('a[target="_blank"]').length + $('a[href^="http"]').length;
  if (extLinks <= 5) {
    findings.push({ item: '外链跳出控制', value: extLinks + ' 个外链', status: 'good', detail: '外链数量可控，用户不易跳出' });
  } else {
    score -= 20;
    findings.push({ item: '外链跳出控制', value: extLinks + ' 个外链', status: 'fair', detail: '外链较多，建议减少非必要外跳，避免用户离开落地页' });
  }

  score = Math.max(0, score);
  const suggestions = [];
  if (!hasPrivacy) suggestions.push('🟡 建议添加隐私提示/隐私政策链接');
  if (hitLimit.length > 0) suggestions.push('🔴 存在极限宣传词，存在虚假宣传风险，建议整改为客观表述');
  if (popupEls.length > 0) suggestions.push('🟡 检测到弹窗，请确认可轻松关闭、非强制骚扰');
  if (extLinks > 5) suggestions.push('🟡 外链较多，建议减少非必要外跳');
  if (suggestions.length === 0) suggestions.push('✅ 合规与干扰项控制良好');

  return { score, findings, suggestions };
}

// ======================== 主分析函数 ========================
async function analyzeLandingPage(rawUrl, opts) {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    throw new Error('请输入有效的网址');
  }

  const startTime = Date.now();

  // 抓取页面
  const response = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    validateStatus: function (status) {
      return status < 500;
    }
  }).catch(err => {
    if (err.code === 'ECONNABORTED') {
      throw new Error('页面请求超时，请检查网址是否正确或稍后重试');
    }
    if (err.code === 'ENOTFOUND') {
      throw new Error('无法解析域名，请检查网址是否正确');
    }
    if (err.response) {
      throw new Error('目标页面返回错误: HTTP ' + err.response.status);
    }
    throw new Error('页面抓取失败: ' + err.message);
  });

  const responseTime = Date.now() - startTime;
  const html = response.data;
  const htmlString = typeof html === 'string' ? html : JSON.stringify(html);
  const $ = cheerio.load(htmlString);
  const htmlLength = Buffer.byteLength(htmlString, 'utf8');

  // 移除 script 和 style 内容用于文本分析
  $('script, style, noscript').remove();

  // 运行十大维度分析
  const results = {
    perf: analyzePerf({ responseTime }, response.headers, $, htmlLength),
    form: analyzeForm($),
    contact: analyzeContact($),
    product: analyzeProduct($),
    marketing: analyzeMarketing($, opts || {}),
    trust: analyzeTrust($),
    cta: analyzeCta($),
    layout: analyzeLayout($),
    mobile: analyzeMobile($),
    compliance: analyzeCompliance($)
  };

  // 计算总分（按权重加权，权重合计100 → 直接加权求和即满分100）
  const totalScore = Math.round(
    DIMENSIONS.reduce((sum, d) => sum + results[d.key].score * d.weight, 0) / 100
  );

  // 生成总体评级
  let grade, gradeColor;
  if (totalScore >= 85) { grade = 'A'; gradeColor = '#52c41a'; }
  else if (totalScore >= 70) { grade = 'B'; gradeColor = '#13c2c2'; }
  else if (totalScore >= 60) { grade = 'C'; gradeColor = '#faad14'; }
  else if (totalScore >= 40) { grade = 'D'; gradeColor = '#fa8c16'; }
  else { grade = 'F'; gradeColor = '#ff4d4f'; }

  // 生成总体建议（取权重最高或得分最低的几个维度）
  const overallSuggestions = [];
  const lowDims = DIMENSIONS
    .map(d => ({ ...d, score: results[d.key].score }))
    .filter(d => d.score < 60)
    .sort((a, b) => (a.score * a.weight) - (b.score * b.weight));
  if (lowDims.length === 0) {
    overallSuggestions.push('落地页整体质量良好，各维度均达标，建议持续优化并定期复检');
  } else {
    lowDims.slice(0, 4).forEach(d => {
      const main = results[d.key].suggestions.find(s => s.includes('🔴')) || results[d.key].suggestions[0];
      if (main) overallSuggestions.push('【' + d.name + '】' + main.replace(/^[🔴🟡]+/, '').trim());
    });
  }

  return {
    url: url,
    timestamp: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    totalScore: totalScore,
    grade: grade,
    gradeColor: gradeColor,
    responseTime: responseTime,
    pageTitle: $('title').text().trim() || '(无标题)',
    dimensions: results,
    dimensionMeta: DIMENSIONS,
    overallSuggestions: overallSuggestions
  };
}

// ======================== 服务端 PDF 生成 ========================

// 中文字体解析：优先环境变量 FONT_PATH → 项目自带 fonts/cn.ttf → 常见系统字体（跨平台）
function resolveCnFont() {
  if (process.env.FONT_PATH && fs.existsSync(process.env.FONT_PATH)) {
    return process.env.FONT_PATH;
  }
  const bundled = path.join(__dirname, 'fonts', 'cn.ttf');
  if (fs.existsSync(bundled)) return bundled;
  const candidates = [
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/msyh.ttc',
    'C:/Windows/Fonts/simsun.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/SONGTI.TTC',
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function pdfScoreColor(score) {
  if (score >= 85) return '#52c41a';
  if (score >= 70) return '#13c2c2';
  if (score >= 50) return '#faad14';
  return '#ff4d4f';
}
function pdfStatusColor(status) {
  return status === 'good' ? '#52c41a' : status === 'fair' ? '#faad14' : '#ff4d4f';
}
function pdfLightColor(status) {
  return status === 'good' ? '#eaf7e6' : status === 'fair' ? '#fff7e6' : '#fff1f0';
}
function pdfStatusText(status) {
  return status === 'good' ? '良好' : status === 'fair' ? '一般' : '较差';
}
function pdfGradeText(grade) {
  const map = { A: '优秀', B: '良好', C: '及格', D: '较差', F: '不及格' };
  return map[grade] || '待检测';
}

function ensureSpace(doc, needed) {
  const margin = 40;
  if (doc.y + needed > doc.page.height - margin) {
    doc.addPage();
  }
}

function pdfScoreBar(doc, label, score, x, y, w) {
  const color = pdfScoreColor(score);
  const labelW = 70;
  doc.fontSize(9.5).fillColor('#333').text(label, x, y + 3);
  const barX = x + labelW;
  const barW = w - labelW - 42;
  const barH = 9;
  doc.roundedRect(barX, y + 1, barW, barH, 3).fill('#e8e8e8');
  if (score > 0) doc.roundedRect(barX, y + 1, Math.max(2, barW * score / 100), barH, 3).fill(color);
  doc.fontSize(9.5).fillColor(color).text(score + ' 分', barX + barW + 4, y + 3);
}

function generatePdfReport(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const cnFont = resolveCnFont();
      if (cnFont) {
        doc.registerFont('CN', cnFont);
        doc.font('CN');
      } else {
        console.warn('[WARN] 未找到中文字体，PDF 中的中文可能显示为方块。请设置环境变量 FONT_PATH 指向一个含中文的 TTF/OTF，或在项目 fonts/ 目录放入 cn.ttf。');
      }

      const margin = 40;
      const pageW = doc.page.width;
      const contentW = pageW - margin * 2;

      // ---- 标题 ----
      doc.fontSize(21).fillColor('#1a1a2e').text('360SEM 落地页诊断报告', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor('#666').text('检测网址：' + data.url, { align: 'center' });
      doc.fontSize(10).fillColor('#666').text('检测时间：' + data.timestamp, { align: 'center' });
      doc.fontSize(10).fillColor('#666').text('页面标题：' + data.pageTitle, { align: 'center' });
      doc.moveDown(0.8);
      doc.moveTo(margin, doc.y).lineTo(pageW - margin, doc.y).lineWidth(2).strokeColor('#4f6bed').stroke();
      doc.moveDown(1);

      // ---- 综合评分框 ----
      const totalColor = pdfScoreColor(data.totalScore);
      const boxY = doc.y;
      const boxH = 130;
      doc.roundedRect(margin, boxY, contentW, boxH, 8).fill('#f5f7fc');
      doc.fillColor(totalColor).fontSize(52).text(String(data.totalScore), margin, boxY + 22, { width: 170, align: 'center' });
      doc.fontSize(10).fillColor('#999').text('综合评分（满分100）', margin, boxY + 92, { width: 170, align: 'center' });
      const badgeX = margin + 190;
      doc.roundedRect(badgeX, boxY + 35, 100, 60, 6).fill('#eef1ff');
      doc.fillColor(totalColor).fontSize(32).text(data.grade, badgeX, boxY + 40, { width: 100, align: 'center' });
      doc.fontSize(11).fillColor('#666').text(pdfGradeText(data.grade), badgeX, boxY + 82, { width: 100, align: 'center' });
      const barsX = badgeX + 130;
      const barsW = pageW - margin - barsX;
      const dimMeta = data.dimensionMeta || [];
      const dimBars = dimMeta.map(d => [d.name + '(' + d.weight + ')', data.dimensions[d.key].score]);
      let by = boxY + 8;
      const step = Math.max(20, (boxH - 16) / Math.max(1, dimBars.length));
      dimBars.forEach(b => { pdfScoreBar(doc, b[0], b[1], barsX, by, barsW); by += step; });
      doc.y = boxY + boxH + 20;

      // ---- 优先整改事项 ----
      if (data.overallSuggestions && data.overallSuggestions.length > 0) {
        ensureSpace(doc, 50);
        doc.fontSize(14).fillColor('#d48806').text('优先整改事项', margin, doc.y);
        doc.moveDown(0.4);
        data.overallSuggestions.forEach(s => {
          ensureSpace(doc, 24);
          doc.fontSize(10.5).fillColor('#614700').text('· ' + s, margin + 8, doc.y, { width: contentW - 16 });
          doc.moveDown(0.2);
        });
        doc.moveDown(0.6);
      }

      // ---- 各维度详细报告（动态）----
      dimMeta.forEach(d => {
        const dim = data.dimensions[d.key];
        const color = pdfScoreColor(dim.score);
        ensureSpace(doc, 140);
        const hY = doc.y;
        doc.roundedRect(margin, hY, contentW, 30, 5).fill(color);
        doc.fillColor('#fff').fontSize(14).text(d.name + '（权重' + d.weight + '分）', margin + 12, hY + 8);
        doc.fillColor('#fff').fontSize(14).text(String(dim.score) + ' 分', pageW - margin - 12, hY + 8, { align: 'right' });
        doc.y = hY + 40;

        // 检测结果
        doc.fontSize(12).fillColor('#333').text('检测结果：', margin + 6, doc.y);
        doc.moveDown(0.3);
        dim.findings.forEach(f => {
          ensureSpace(doc, 46);
          const fy = doc.y;
          const c2 = pdfStatusColor(f.status);
          doc.fontSize(10.5).fillColor('#1a1a2e').text(f.item, margin + 12, fy);
          const sText = pdfStatusText(f.status);
          const sW = 36;
          doc.roundedRect(pageW - margin - sW, fy, sW, 16, 3).fill(pdfLightColor(f.status));
          doc.fillColor(c2).fontSize(9).text(sText, pageW - margin - sW, fy + 3, { width: sW, align: 'center' });
          doc.y = fy + 19;
          doc.fontSize(9.5).fillColor('#555').text('数值：' + f.value, margin + 12, doc.y, { width: contentW - 24 });
          doc.fontSize(9).fillColor('#999').text(f.detail, margin + 12, doc.y, { width: contentW - 24 });
          doc.moveDown(0.4);
        });

        // 整改建议
        doc.fontSize(12).fillColor('#333').text('整改建议：', margin + 6, doc.y);
        doc.moveDown(0.3);
        dim.suggestions.forEach(s => {
          ensureSpace(doc, 22);
          doc.fontSize(10).fillColor('#555').text('· ' + s, margin + 12, doc.y, { width: contentW - 24 });
          doc.moveDown(0.25);
        });
        doc.moveDown(0.5);

        // 分隔线
        doc.moveTo(margin, doc.y).lineTo(pageW - margin, doc.y).strokeColor('#eee').lineWidth(1).stroke();
        doc.moveDown(0.8);
      });

      // ---- 页脚 ----
      doc.moveDown(0.5);
      doc.fontSize(9).fillColor('#999').text('本报告由 360SEM 落地页诊断工具自动生成  |  ' + new Date().toLocaleDateString('zh-CN'), { align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ======================== API 路由 ========================

app.post('/api/analyze', async (req, res) => {
  try {
    const { url, searchKeyword, adText } = req.body;
    if (!url) {
      return res.status(400).json({ error: '请输入要检测的网址' });
    }
    const result = await analyzeLandingPage(url, { searchKeyword, adText });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 服务端生成 PDF 并下载
app.post('/api/export-pdf', async (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.url || !data.dimensions || !data.dimensionMeta) {
      return res.status(400).send('无效的诊断数据');
    }
    const pdfBuffer = await generatePdfReport(data);
    const safeUrl = data.url.replace(/[\\/:*?"<>|\s]/g, '_').substring(0, 60);
    const filename = safeUrl + '_360SEM落地页诊断报告.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="360SEM-report.pdf"; filename*=UTF-8\'\'' + encodeURIComponent(filename));
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).send('PDF生成失败: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log('========================================');
  console.log('  360SEM 落地页诊断工具已启动');
  console.log('  访问地址: http://localhost:' + PORT);
  console.log('  部署环境: ' + (process.env.PORT ? '云端 (PORT=' + PORT + ')' : '本地'));
  console.log('========================================');
});
