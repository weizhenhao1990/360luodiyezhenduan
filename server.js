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

// ======================== 维度一：加载速度分析 ========================

function analyzeSpeed(timing, headers, $, htmlLength) {
  const findings = [];
  let score = 0;
  let maxScore = 100;

  const responseTime = timing.responseTime; // ms
  const pageSize = htmlLength; // bytes
  const resourceCount = $('img, script, link[rel="stylesheet"], iframe').length;
  const blockingResources = $('head script:not([async]):not([defer]), head link[rel="stylesheet"]').length;
  const imgCount = $('img').length;
  const imgWithoutAlt = $('img:not([alt])').length;
  const cssCount = $('link[rel="stylesheet"]').length;
  const jsCount = $('script').length;
  const inlineStyleCount = $('[style]').length;

  // 响应时间评分 (40分)
  let responseTimeScore = 0;
  if (responseTime < 800) responseTimeScore = 40;
  else if (responseTime < 1500) responseTimeScore = 32;
  else if (responseTime < 3000) responseTimeScore = 22;
  else if (responseTime < 5000) responseTimeScore = 12;
  else responseTimeScore = 4;
  score += responseTimeScore;

  findings.push({
    item: '服务器响应时间',
    value: responseTime + ' ms',
    status: responseTime < 800 ? 'good' : responseTime < 3000 ? 'fair' : 'poor',
    detail: responseTime < 800 ? '响应迅速，用户体验良好' : responseTime < 3000 ? '响应一般，有一定优化空间' : '响应较慢，严重影响用户体验和转化'
  });

  // 页面体积评分 (30分)
  let pageSizeScore = 0;
  if (pageSize < 100 * 1024) pageSizeScore = 30;
  else if (pageSize < 300 * 1024) pageSizeScore = 25;
  else if (pageSize < 800 * 1024) pageSizeScore = 18;
  else if (pageSize < 2 * 1024 * 1024) pageSizeScore = 10;
  else pageSizeScore = 4;
  score += pageSizeScore;

  findings.push({
    item: 'HTML页面体积',
    value: formatSize(pageSize),
    status: pageSize < 300 * 1024 ? 'good' : pageSize < 1024 * 1024 ? 'fair' : 'poor',
    detail: pageSize < 300 * 1024 ? '页面体积适中' : pageSize < 1024 * 1024 ? '页面体积偏大，建议精简' : '页面体积过大，严重影响加载速度'
  });

  // 资源数量评分 (20分)
  let resourceScore = 0;
  if (resourceCount < 15) resourceScore = 20;
  else if (resourceCount < 30) resourceScore = 16;
  else if (resourceCount < 50) resourceScore = 10;
  else if (resourceCount < 100) resourceScore = 5;
  else resourceScore = 2;
  score += resourceScore;

  findings.push({
    item: '页面资源总数',
    value: resourceCount + ' 个 (JS:' + jsCount + ' CSS:' + cssCount + ' IMG:' + imgCount + ')',
    status: resourceCount < 30 ? 'good' : resourceCount < 50 ? 'fair' : 'poor',
    detail: resourceCount < 30 ? '资源数量合理' : resourceCount < 50 ? '资源偏多，建议合并静态资源' : '资源过多，大量HTTP请求拖慢加载'
  });

  // 阻塞资源评分 (10分)
  let blockingScore = 0;
  if (blockingResources <= 2) blockingScore = 10;
  else if (blockingResources <= 5) blockingScore = 7;
  else if (blockingResources <= 10) blockingScore = 4;
  else blockingScore = 2;
  score += blockingScore;

  findings.push({
    item: '头部阻塞资源',
    value: blockingResources + ' 个',
    status: blockingResources <= 5 ? 'good' : 'poor',
    detail: blockingResources <= 5 ? '阻塞资源较少' : '头部阻塞资源过多，建议JS添加defer/async或移至底部'
  });

  // 图片优化
  if (imgCount > 0) {
    findings.push({
      item: '图片alt属性完整度',
      value: (imgCount - imgWithoutAlt) + '/' + imgCount + ' 已添加',
      status: imgWithoutAlt === 0 ? 'good' : imgWithoutAlt < imgCount / 2 ? 'fair' : 'poor',
      detail: imgWithoutAlt === 0 ? '所有图片均有alt属性' : imgWithoutAlt + '张图片缺少alt属性，影响SEO和可访问性'
    });
  }

  // 内联样式检查
  if (inlineStyleCount > 20) {
    findings.push({
      item: '内联样式数量',
      value: inlineStyleCount + ' 处',
      status: 'fair',
      detail: '内联样式过多，建议提取为外部CSS文件以利用缓存'
    });
  }

  // 整改建议
  const suggestions = [];
  if (responseTime >= 1500) {
    suggestions.push('🔴 服务器响应时间较长，建议：使用CDN加速、升级服务器配置、启用页面缓存、优化数据库查询');
  }
  if (pageSize >= 800 * 1024) {
    suggestions.push('🔴 页面体积过大，建议：压缩HTML/CSS/JS、使用Gzip压缩、精简冗余代码、懒加载非首屏图片');
  }
  if (resourceCount >= 50) {
    suggestions.push('🟡 资源数量过多，建议：合并CSS/JS文件、使用CSS Sprite、移除不必要的第三方插件和库');
  }
  if (blockingResources > 5) {
    suggestions.push('🟡 头部阻塞资源过多，建议：给JS添加defer/async属性、将非关键JS移至页面底部、内联关键CSS');
  }
  if (imgWithoutAlt > 0) {
    suggestions.push('🟡 部分图片缺少alt属性，建议：为所有图片添加描述性alt文本，利于SEO和可访问性');
  }
  if (suggestions.length === 0) {
    suggestions.push('✅ 页面加载性能良好，建议持续监控并定期优化');
  }

  return { score: Math.round(score), maxScore, findings, suggestions, metrics: { responseTime, pageSize, resourceCount, blockingResources, imgCount, cssCount, jsCount } };
}

// ======================== 维度二：转化表单/按钮分析 ========================

function analyzeConversion($) {
  const findings = [];
  let score = 0;

  // CTA 关键词列表
  const ctaKeywords = [
    '立即咨询', '免费咨询', '在线咨询', '马上咨询', '一键咨询',
    '立即注册', '免费注册', '马上注册',
    '立即购买', '马上购买', '立即下单', '去购买',
    '立即预约', '免费预约', '在线预约', '马上预约', '预约报名',
    '提交', '提交申请', '提交表单',
    '报名', '免费报名', '立即报名',
    '领取', '免费领取', '立即领取',
    '下载', '免费下载', '立即下载',
    '获取', '获取方案', '获取报价',
    '试听', '免费试听', '预约试听',
    '申请', '免费申请', '立即申请',
    '联系', '联系我们', '联系客服',
    '订阅', '关注', '加入',
    '了解详情', '查看详情', '更多详情',
    '立即体验', '免费体验', '开始使用',
    '获取报价', '免费报价', '询价',
    '留言', '在线留言',
    '拨打电话', '电话咨询',
    '加微', '加微信', '扫码',
    '免费获取', '免费试用'
  ];

  // 检测表单
  const forms = $('form');
  const formCount = forms.length;
  if (formCount > 0) {
    score += 30;
    let formDetails = [];
    forms.each((i, el) => {
      const inputs = $(el).find('input, select, textarea');
      const action = $(el).attr('action') || '';
      const method = $(el).attr('method') || '';
      const inputTypes = [];
      inputs.each((j, input) => {
        const type = $(input).attr('type') || $(input).get(0).tagName;
        inputTypes.push(type);
      });
      formDetails.push({
        inputs: inputs.length,
        action: action ? '已配置' : '未配置',
        method: method || '未指定',
        fields: inputTypes
      });
    });
    findings.push({
      item: '表单元素',
      value: formCount + ' 个表单',
      status: 'good',
      detail: '检测到' + formCount + '个表单，共包含' + formDetails.reduce((s, f) => s + f.inputs, 0) + '个输入字段'
    });

    // 表单 action 检查
    const noActionForms = formDetails.filter(f => f.action === '未配置');
    if (noActionForms.length > 0) {
      findings.push({
        item: '表单提交地址',
        value: noActionForms.length + '/' + formCount + ' 缺少action',
        status: 'poor',
        detail: noActionForms.length + '个表单未配置action属性，可能导致表单无法正常提交'
      });
    }

    // 检测表单字段类型
    const allFields = formDetails.flatMap(f => f.fields);
    const hasPhone = allFields.some(f => f === 'tel' || f === 'phone');
    const hasEmail = allFields.some(f => f === 'email');
    const hasName = allFields.some(f => f === 'text' || f === 'name');
    const fieldTypes = [];
    if (hasName) fieldTypes.push('姓名');
    if (hasPhone) fieldTypes.push('电话');
    if (hasEmail) fieldTypes.push('邮箱');
    findings.push({
      item: '表单字段类型',
      value: fieldTypes.length > 0 ? fieldTypes.join('、') : '通用文本',
      status: hasPhone ? 'good' : 'fair',
      detail: hasPhone ? '表单包含电话字段，便于销售跟进转化' : '建议在表单中添加电话输入框(type="tel")，方便收集客户联系方式'
    });
  } else {
    findings.push({
      item: '表单元素',
      value: '0 个',
      status: 'poor',
      detail: '未检测到任何表单元素，用户无法在线提交信息，严重影响转化率'
    });
  }

  // 检测按钮
  const buttons = $('button, input[type="submit"], input[type="button"], a.btn, a.button, [class*="btn"], [class*="button"]');
  const buttonCount = buttons.length;
  if (buttonCount > 0) {
    score += 20;
    findings.push({
      item: '按钮元素',
      value: buttonCount + ' 个按钮',
      status: buttonCount >= 2 ? 'good' : 'fair',
      detail: '检测到' + buttonCount + '个按钮元素'
    });
  } else {
    findings.push({
      item: '按钮元素',
      value: '0 个',
      status: 'poor',
      detail: '未检测到明显的按钮元素，建议添加醒目的行动号召按钮'
    });
  }

  // 检测 CTA 文本
  const pageText = $('body').text().toLowerCase();
  const foundCTAs = [];
  const allLinks = $('a');
  let ctaLinkCount = 0;

  ctaKeywords.forEach(keyword => {
    const regex = new RegExp(keyword, 'gi');
    if (regex.test(pageText)) {
      foundCTAs.push(keyword);
    }
    allLinks.each((i, el) => {
      const linkText = $(el).text().trim();
      if (linkText.includes(keyword)) {
        ctaLinkCount++;
      }
    });
  });

  const uniqueCTAs = [...new Set(foundCTAs)];
  if (uniqueCTAs.length > 0) {
    let ctaScore = Math.min(25, uniqueCTAs.length * 6);
    score += ctaScore;
    findings.push({
      item: '行动号召(CTA)关键词',
      value: uniqueCTAs.length + ' 种 ("' + uniqueCTAs.slice(0, 5).join('", "') + (uniqueCTAs.length > 5 ? '"...' : '"') + ')',
      status: uniqueCTAs.length >= 3 ? 'good' : 'fair',
      detail: '检测到' + uniqueCTAs.length + '种CTA关键词' + (ctaLinkCount > 0 ? '，其中' + ctaLinkCount + '个链接包含CTA文本' : '')
    });
  } else {
    findings.push({
      item: '行动号召(CTA)关键词',
      value: '未检测到',
      status: 'poor',
      detail: '页面未检测到常见的行动号召关键词，用户缺乏明确的转化引导'
    });
  }

  // CTA 位置多样性
  if (ctaLinkCount >= 3) {
    score += 15;
    findings.push({
      item: 'CTA按钮分布',
      value: ctaLinkCount + ' 个CTA链接',
      status: 'good',
      detail: '页面多处设置了CTA链接，用户在不同位置都能找到转化入口'
    });
  } else if (ctaLinkCount >= 1) {
    score += 8;
    findings.push({
      item: 'CTA按钮分布',
      value: ctaLinkCount + ' 个CTA链接',
      status: 'fair',
      detail: 'CTA链接数量较少，建议在首屏、文中、页尾等多个位置添加转化入口'
    });
  }

  // 浮动咨询窗检测
  const floatElements = $('[class*="float"], [class*="fixed"], [class*="suspend"], [class*="popup"], [id*="float"], [id*="suspend"]');
  if (floatElements.length > 0) {
    score += 10;
    findings.push({
      item: '浮动咨询组件',
      value: '检测到 ' + floatElements.length + ' 个',
      status: 'good',
      detail: '检测到浮动/悬浮元素，可能包含在线咨询窗或浮动按钮，有助于提高转化'
    });
  } else {
    findings.push({
      item: '浮动咨询组件',
      value: '未检测到',
      status: 'fair',
      detail: '未检测到浮动咨询组件，建议添加右侧悬浮咨询按钮或在线客服窗口'
    });
  }

  // 整改建议
  const suggestions = [];
  if (formCount === 0) {
    suggestions.push('🔴 页面缺少表单，强烈建议添加在线咨询/注册/预约表单，这是落地页最核心的转化工具');
  }
  if (uniqueCTAs.length === 0) {
    suggestions.push('🔴 缺少明确的行动号召(CTA)，建议添加"立即咨询"、"免费注册"、"获取报价"等醒目按钮');
  }
  if (buttonCount === 0) {
    suggestions.push('🔴 未检测到按钮元素，建议添加视觉醒目的CTA按钮，使用对比色突出显示');
  }
  if (ctaLinkCount < 3) {
    suggestions.push('🟡 CTA入口不足，建议在首屏、产品介绍区、页尾等至少3个位置放置转化按钮');
  }
  if (floatElements.length === 0) {
    suggestions.push('🟡 建议添加浮动在线咨询窗口或悬浮客服按钮，让用户随时可以发起咨询');
  }
  const noActionForms = $('form:not([action])').length;
  if (noActionForms > 0) {
    suggestions.push('🔴 ' + noActionForms + '个表单缺少action属性，请确保表单能正确提交到后端处理接口');
  }
  if (suggestions.length === 0) {
    suggestions.push('✅ 转化元素配置完善，建议持续A/B测试不同CTA文案和按钮位置以优化转化率');
  }

  return { score: Math.min(100, Math.round(score)), maxScore: 100, findings, suggestions };
}

// ======================== 维度三：联系方式分析 ========================

function analyzeContact($) {
  const findings = [];
  let score = 0;
  // 提取可见纯文本（剔除 script/style/noscript，避免 JS/CSS 里的数字被误判为电话/地址）
  const html = $.html();
  const bodyClone = $('body').clone();
  bodyClone.find('script, style, noscript').remove();
  const pageText = bodyClone.text();

  // 电话号码检测（在可见纯文本上匹配，避免 JS/CSS 噪声；最后用归一化规则二次校验）
  const phoneRawRegex = [
    /(?:\+?86[-\s]?)?(?:400|800)[-\s.]?(\d{3,4})[-\s.]?(\d{4})/g,   // 400 / 800 免费电话（含 +86）
    /(?:\+?86[-\s]?)?1[3-9]\d[-\s.]?\d{4}[-\s.]?\d{4}/g,             // 手机号（11 位，含 +86）
    /\(?0\d{2,3}\)?[-\s.]?\d{3,4}[-\s.]?\d{3,4}/g,                 // 座机 / 固定电话（区号-号码、(区号)号码，允许中段空格）
  ];
  const rawPhones = [];
  phoneRawRegex.forEach(p => {
    const m = pageText.match(p);
    if (m) m.forEach(s => rawPhones.push(s.trim()));
  });
  // tel: 拨号链接
  $('a[href^="tel:"]').each((i, el) => {
    const h = ($(el).attr('href') || '').replace(/^tel:/i, '').trim();
    if (h) rawPhones.push(h);
  });

  // 归一化（去分隔符 / 国家码）-> 校验 -> 去重
  const phones = new Set();
  rawPhones.forEach(raw => {
    let d = raw.replace(/[^\d]/g, '');
    if (d.startsWith('86') && d.length === 13) d = d.slice(2);   // 去掉 +86 国家码
    if (/^1[3-9]\d{9}$/.test(d)) {
      phones.add(d);                                              // 手机号
    } else if (/^(400|800)\d{7}$/.test(d)) {
      phones.add(d);                                              // 400 / 800
    } else if (/^0\d{9,11}$/.test(d) && !/^0{10,12}$/.test(d)) {
      phones.add(d);                                              // 座机（排除纯 0 串）
    }
  });

  if (phones.size > 0) {
    score += 30;
    const phoneList = [...phones].slice(0, 5);
    const has400 = phoneList.some(p => p.startsWith('400') || p.startsWith('800'));
    const labeled = phoneList.map(p => {
      if (/^1[3-9]\d{9}$/.test(p)) return p + '(手机)';
      if (/^(400|800)/.test(p)) return p + '(400)';
      return p + '(座机)';
    });
    findings.push({
      item: '联系电话',
      value: phones.size + ' 个 (' + labeled.join(', ') + (phones.size > 5 ? '...' : '') + ')',
      status: has400 ? 'good' : 'fair',
      detail: has400 ? '检测到400/800电话，专业度高，显著增强用户信任' : '检测到联系电话，建议使用400电话统一对外形象、提升信任'
    });
  } else {
    findings.push({
      item: '联系电话',
      value: '未检测到',
      status: 'poor',
      detail: '未检测到任何电话号码，用户无法通过电话联系，严重影响信任和转化'
    });
  }

  // 邮箱检测
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = new Set();
  const emailMatches = pageText.match(emailRegex);
  if (emailMatches) emailMatches.forEach(m => emails.add(m));
  const mailtoLinks = $('a[href^="mailto:"]');
  if (mailtoLinks.length > 0) {
    mailtoLinks.each((i, el) => {
      emails.add($(el).attr('href').replace('mailto:', ''));
    });
  }

  if (emails.size > 0) {
    score += 20;
    findings.push({
      item: '电子邮箱',
      value: emails.size + ' 个 (' + [...emails].slice(0, 3).join(', ') + ')',
      status: 'good',
      detail: '检测到邮箱地址，为用户提供了正式的沟通渠道'
    });
  } else {
    findings.push({
      item: '电子邮箱',
      value: '未检测到',
      status: 'fair',
      detail: '未检测到邮箱地址，建议添加企业邮箱提升专业形象'
    });
  }

  // QQ/微信检测
  const qqRegex = /QQ[\s:：]*\d{5,12}/gi;
  const wechatRegex = /(?:微信|微信号|wechat|weixin)[\s:：]*[a-zA-Z0-9_-]{4,30}/gi;
  const qqGroupRegex = /(?:QQ群|加群)[\s:：]*\d{5,12}/gi;
  const qqs = pageText.match(qqRegex);
  const wechats = pageText.match(wechatRegex);
  const qqGroups = pageText.match(qqGroupRegex);

  if (qqs || wechats || qqGroups) {
    score += 20;
    const ims = [];
    if (qqs) ims.push('QQ:' + qqs.length);
    if (wechats) ims.push('微信:' + wechats.length);
    if (qqGroups) ims.push('QQ群:' + qqGroups.length);
    findings.push({
      item: '即时通讯(QQ/微信)',
      value: ims.join(', '),
      status: 'good',
      detail: '检测到即时通讯联系方式，方便用户快速沟通'
    });
  } else {
    findings.push({
      item: '即时通讯(QQ/微信)',
      value: '未检测到',
      status: 'fair',
      detail: '未检测到QQ/微信等即时通讯方式，建议添加在线客服或微信二维码'
    });
  }

  // 地址检测：两路并行 —— 关键词附近的真实地址 + 无关键词时按行政区划/道路门牌模式直接抓取
  let addressFound = false;
  let addressText = '';
  const addrFeature = /(省|市|区|县|旗|镇|路|街|道|巷|大道|大街|号|栋|幢|楼|大厦|广场|园区|花园|中心|室|层|座)/;

  // 4a. 关键词附近（排除“网站地址 / 邮箱地址 / 域名”等）
  const exclAddr = /(网站|域名|邮箱|邮件|url|网址)/i;
  $('body *').each((i, el) => {
    if (addressFound) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
    const t = $(el).clone().children().remove().end().text().trim();
    if (!t) return;
    const kwStart = t.search(/地址|公司位于|位于|办公地点|所在地/);
    if (kwStart === -1) return;
    if (exclAddr.test(t)) return;                                   // 命中排除词，不是实体地址
    if (!addrFeature.test(t)) return;                               // 没有真实地址特征
    addressFound = true;
    addressText = t.length > 70 ? t.substring(kwStart, kwStart + 70).trim() : t;
  });

  // 4b. 无关键词时，按“省/市/区 + 路/街 + 号/楼”模式直接抓取
  if (!addressFound) {
    const addrPat = /([\u4e00-\u9fa5]{2,8}(?:省|市|区|县|旗|镇))[\u4e00-\u9fa50-9\s]*(?:[\u4e00-\u9fa5]{1,12}(?:路|街|道|巷|大道|大街))[\u4e00-\u9fa50-9\s]*(?:[\u4e00-\u9fa50-9]{1,12}(?:号|栋|幢|楼|大厦|广场|园区|花园|中心|室|层|座))?/g;
    const m = pageText.match(addrPat);
    if (m && m.length) {
      addressFound = true;
      addressText = m[0].trim();
    }
  }

  if (addressFound) {
    score += 15;
    const shown = addressText.length > 60 ? addressText.substring(0, 60) + '...' : addressText;
    findings.push({
      item: '公司地址',
      value: '已展示',
      status: 'good',
      detail: '检测到公司地址信息，增强企业可信度: ' + shown
    });
  } else {
    findings.push({
      item: '公司地址',
      value: '未检测到',
      status: 'fair',
      detail: '未检测到公司地址，建议添加详细办公地址（含省市区、道路门牌）以增强企业可信度'
    });
  }

  // 联系我们页面链接
  const contactLinks = $('a').filter((i, el) => {
    const text = $(el).text().toLowerCase();
    const href = ($(el).attr('href') || '').toLowerCase();
    return text.includes('联系') || text.includes('contact') || href.includes('contact') || href.includes('lianxi');
  });

  if (contactLinks.length > 0) {
    score += 15;
    findings.push({
      item: '联系我们入口',
      value: contactLinks.length + ' 个链接',
      status: 'good',
      detail: '检测到"联系我们"相关链接，方便用户查看详细联系方式'
    });
  } else {
    findings.push({
      item: '联系我们入口',
      value: '未检测到',
      status: 'fair',
      detail: '未检测到"联系我们"页面链接，建议在导航栏添加联系我们入口'
    });
  }

  // 整改建议
  const suggestions = [];
  if (phones.size === 0) {
    suggestions.push('🔴 未检测到联系电话，强烈建议添加400电话或客服热线，这是建立信任的基本要素');
  } else if (![...phones].some(p => p.startsWith('400') || p.startsWith('800'))) {
    suggestions.push('🟡 建议申请400/800电话替代普通手机/座机号码，提升企业专业形象和用户信任度');
  }
  if (emails.size === 0) {
    suggestions.push('🟡 建议添加企业邮箱(如service@company.com)，提供正式沟通渠道');
  }
  if (!qqs && !wechats && !qqGroups) {
    suggestions.push('🟡 建议添加QQ/微信客服或二维码，方便用户即时咨询沟通');
  }
  if (!addressFound) {
    suggestions.push('🟡 建议在页脚展示公司详细地址，配合地图定位增强可信度');
  }
  if (contactLinks.length === 0) {
    suggestions.push('🟡 建议在导航栏添加"联系我们"页面，集中展示所有联系方式');
  }
  if (suggestions.length === 0) {
    suggestions.push('✅ 联系方式展示完善，建议确保电话可在移动端一键拨打，微信二维码清晰可扫');
  }

  return { score: Math.min(100, Math.round(score)), maxScore: 100, findings, suggestions };
}

// ======================== 维度四：产品介绍清晰度分析 ========================

function analyzeProductClarity($) {
  const findings = [];
  let score = 0;

  // H1 标题检测
  const h1Count = $('h1').length;
  if (h1Count > 0) {
    score += 15;
    const h1Text = $('h1').first().text().trim();
    findings.push({
      item: 'H1主标题',
      value: h1Text.substring(0, 40) || '(无文本)',
      status: 'good',
      detail: '检测到H1标题，有助于用户快速理解页面主题'
    });
  } else {
    findings.push({
      item: 'H1主标题',
      value: '未检测到',
      status: 'poor',
      detail: '缺少H1标题，用户无法快速识别页面核心内容，严重影响SEO和用户体验'
    });
  }

  // H2/H3 标题层级检测
  const h2Count = $('h2').length;
  const h3Count = $('h3').length;
  if (h2Count > 0 || h3Count > 0) {
    score += 15;
    findings.push({
      item: '标题层级结构',
      value: 'H2:' + h2Count + ' H3:' + h3Count,
      status: h2Count >= 2 ? 'good' : 'fair',
      detail: '检测到标题层级结构，内容组织清晰' + (h2Count >= 2 ? '' : '，建议增加H2分段标题')
    });
  } else {
    findings.push({
      item: '标题层级结构',
      value: '未检测到H2/H3',
      status: 'poor',
      detail: '缺少子标题层级，内容结构不清晰，建议使用H2/H3组织产品卖点'
    });
  }

  // 文本内容量检测
  const bodyText = $('body').text().replace(/\s+/g, '');
  const textLength = bodyText.length;
  let textScore = 0;
  if (textLength > 1000) textScore = 20;
  else if (textLength > 500) textScore = 15;
  else if (textLength > 200) textScore = 8;
  else textScore = 2;
  score += textScore;

  findings.push({
    item: '页面文本内容量',
    value: textLength + ' 字',
    status: textLength > 500 ? 'good' : textLength > 200 ? 'fair' : 'poor',
    detail: textLength > 500 ? '内容充实，能够充分介绍产品信息' : textLength > 200 ? '内容偏少，建议增加产品详细描述' : '内容严重不足，用户无法了解产品详情'
  });

  // 图片检测
  const imgCount = $('img').length;
  if (imgCount > 0) {
    score += 15;
    const imgWithAlt = $('img[alt]').length;
    findings.push({
      item: '产品图片',
      value: imgCount + ' 张 (有alt:' + imgWithAlt + ')',
      status: imgCount >= 3 ? 'good' : 'fair',
      detail: '检测到' + imgCount + '张图片' + (imgWithAlt === imgCount ? '，且均有alt描述' : '，部分缺少alt描述')
    });
  } else {
    findings.push({
      item: '产品图片',
      value: '0 张',
      status: 'poor',
      detail: '未检测到图片，纯文字页面缺乏视觉吸引力，建议添加产品展示图'
    });
  }

  // Meta 描述检测
  const metaDesc = $('meta[name="description"]').attr('content');
  if (metaDesc && metaDesc.trim().length > 20) {
    score += 10;
    findings.push({
      item: 'Meta描述',
      value: metaDesc.trim().substring(0, 50) + '...',
      status: 'good',
      detail: '检测到页面描述标签，有助于搜索引擎展示和用户理解'
    });
  } else {
    findings.push({
      item: 'Meta描述',
      value: '未配置',
      status: 'poor',
      detail: '缺少meta description，影响搜索结果展示和点击率'
    });
  }

  // 产品关键词检测
  const productKeywords = [
    '产品', '服务', '功能', '特点', '优势', '方案', '价格', '报价',
    '案例', '简介', '介绍', '说明', '特色', '特性', '规格', '参数',
    '适用', '场景', '解决', '问题', '需求', '价值', '效益', '效果',
    '品牌', '专业', '领先', '创新', '品质', '保障', '承诺', '服务',
    '流程', '步骤', '方法', '技术', '工艺', '材料', '认证', '资质'
  ];
  let keywordCount = 0;
  const foundKeywords = [];
  const lowerText = bodyText.toLowerCase();
  productKeywords.forEach(kw => {
    if (bodyText.includes(kw)) {
      keywordCount++;
      foundKeywords.push(kw);
    }
  });

  if (keywordCount >= 5) {
    score += 15;
    findings.push({
      item: '产品描述关键词',
      value: keywordCount + ' 类 (' + foundKeywords.slice(0, 6).join('、') + ')',
      status: 'good',
      detail: '页面包含丰富的产品描述关键词，产品介绍较为全面'
    });
  } else if (keywordCount >= 2) {
    score += 8;
    findings.push({
      item: '产品描述关键词',
      value: keywordCount + ' 类 (' + foundKeywords.join('、') + ')',
      status: 'fair',
      detail: '检测到部分产品关键词，建议增加功能特点、案例等描述'
    });
  } else {
    findings.push({
      item: '产品描述关键词',
      value: keywordCount + ' 类',
      status: 'poor',
      detail: '产品描述关键词匮乏，用户难以了解产品具体信息'
    });
  }

  // 案例展示检测
  const caseKeywords = ['案例', '客户案例', '成功案例', '合作客户', '客户展示', '项目案例'];
  const hasCase = caseKeywords.some(kw => bodyText.includes(kw)) || $('[class*="case"]').length > 0;
  if (hasCase) {
    findings.push({
      item: '案例展示',
      value: '已展示',
      status: 'good',
      detail: '检测到案例展示内容，有助于增强说服力和信任感'
    });
  } else {
    findings.push({
      item: '案例展示',
      value: '未检测到',
      status: 'fair',
      detail: '未检测到客户案例，建议添加成功案例或合作客户展示增强说服力'
    });
  }

  // 信任元素检测
  const trustElements = [];
  if ($('[class*="honor"], [class*="certif"], [class*="award"], [class*="qualification"]').length > 0) trustElements.push('资质荣誉');
  if (bodyText.includes('版权') || bodyText.includes('©') || bodyText.includes('Copyright')) trustElements.push('版权信息');
  if ($('[class*="partner"], [class*="brand"]').length > 0) trustElements.push('合作品牌');
  if (bodyText.includes('ICP') || $('a[href*="beian"]').length > 0) trustElements.push('ICP备案');

  if (trustElements.length > 0) {
    findings.push({
      item: '信任元素',
      value: trustElements.join('、'),
      status: 'good',
      detail: '检测到信任元素，增强页面可信度'
    });
  } else {
    findings.push({
      item: '信任元素',
      value: '未检测到',
      status: 'fair',
      detail: '缺少资质荣誉、备案信息等信任元素，建议添加以增强可信度'
    });
  }

  // 整改建议
  const suggestions = [];
  if (h1Count === 0) {
    suggestions.push('🔴 缺少H1主标题，建议添加包含核心关键词的产品/服务标题，让用户3秒内知道你是做什么的');
  }
  if (h2Count === 0 && h3Count === 0) {
    suggestions.push('🔴 缺少子标题层级，建议使用H2/H3将内容分为"产品特点"、"应用场景"、"客户案例"等板块');
  }
  if (textLength < 500) {
    suggestions.push('🔴 文本内容过少，建议补充产品功能说明、技术参数、应用场景、客户价值等详细描述');
  }
  if (imgCount === 0) {
    suggestions.push('🔴 缺少图片，建议添加产品展示图、场景图、案例图等，图文并茂提升阅读体验');
  }
  if (!metaDesc) {
    suggestions.push('🟡 缺少meta description，建议添加80-160字的页面描述，影响搜索结果展示和点击率');
  }
  if (keywordCount < 5) {
    suggestions.push('🟡 产品描述不够全面，建议增加功能特点、技术参数、应用场景、价格方案等内容');
  }
  if (!hasCase) {
    suggestions.push('🟡 建议添加客户成功案例展示，用真实案例增强说服力');
  }
  if (trustElements.length === 0) {
    suggestions.push('🟡 建议添加资质认证、荣誉奖项、ICP备案等信任元素，增强企业可信度');
  }
  if (suggestions.length === 0) {
    suggestions.push('✅ 产品介绍清晰完整，建议定期更新案例和内容保持页面新鲜度');
  }

  return { score: Math.min(100, Math.round(score)), maxScore: 100, findings, suggestions };
}

// ======================== 主分析函数 ========================

async function analyzeLandingPage(rawUrl) {
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

  // 运行四大维度分析
  const speedResult = analyzeSpeed({ responseTime }, response.headers, $, htmlLength);
  const conversionResult = analyzeConversion($);
  const contactResult = analyzeContact($);
  const productResult = analyzeProductClarity($);

  // 计算总分
  const totalScore = Math.round(
    speedResult.score * 0.25 +
    conversionResult.score * 0.25 +
    contactResult.score * 0.25 +
    productResult.score * 0.25
  );

  // 生成总体评级
  let grade, gradeColor;
  if (totalScore >= 85) { grade = 'A'; gradeColor = '#52c41a'; }
  else if (totalScore >= 70) { grade = 'B'; gradeColor = '#13c2c2'; }
  else if (totalScore >= 60) { grade = 'C'; gradeColor = '#faad14'; }
  else if (totalScore >= 40) { grade = 'D'; gradeColor = '#fa8c16'; }
  else { grade = 'F'; gradeColor = '#ff4d4f'; }

  // 生成总体建议
  const overallSuggestions = [];
  if (speedResult.score < 60) overallSuggestions.push('优化页面加载速度是当前最紧急的任务');
  if (conversionResult.score < 60) overallSuggestions.push('完善转化表单和CTA按钮是提升转化的关键');
  if (contactResult.score < 60) overallSuggestions.push('补充联系方式是建立用户信任的基础');
  if (productResult.score < 60) overallSuggestions.push('优化产品介绍内容是提高页面说服力的核心');

  return {
    url: url,
    timestamp: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    totalScore: totalScore,
    grade: grade,
    gradeColor: gradeColor,
    responseTime: responseTime,
    pageTitle: $('title').text().trim() || '(无标题)',
    dimensions: {
      speed: speedResult,
      conversion: conversionResult,
      contact: contactResult,
      product: productResult
    },
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
  const labelW = 58;
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
      const dimBars = [
        ['加载速度', data.dimensions.speed.score],
        ['转化表单', data.dimensions.conversion.score],
        ['联系方式', data.dimensions.contact.score],
        ['产品介绍', data.dimensions.product.score]
      ];
      let by = boxY + 18;
      dimBars.forEach(b => { pdfScoreBar(doc, b[0], b[1], barsX, by, barsW); by += 26; });
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

      // ---- 四维度详细报告 ----
      const dimMeta = [
        { key: 'speed', name: '加载速度' },
        { key: 'conversion', name: '转化表单' },
        { key: 'contact', name: '联系方式' },
        { key: 'product', name: '产品介绍' }
      ];

      dimMeta.forEach(d => {
        const dim = data.dimensions[d.key];
        const color = pdfScoreColor(dim.score);
        ensureSpace(doc, 140);
        // 维度头部色块
        const hY = doc.y;
        doc.roundedRect(margin, hY, contentW, 30, 5).fill(color);
        doc.fillColor('#fff').fontSize(14).text(d.name + '分析', margin + 12, hY + 8);
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
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: '请输入要检测的网址' });
    }
    const result = await analyzeLandingPage(url);
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
    if (!data || !data.url || !data.dimensions) {
      return res.status(400).send('无效的诊断数据');
    }
    const pdfBuffer = await generatePdfReport(data);
    // 文件名格式：网址_360SEM落地页诊断报告.pdf（兜底用，前端下载以 a.download 为准）
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
