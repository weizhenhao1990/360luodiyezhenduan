// ======================== DOM 元素引用 ========================
const urlInput = document.getElementById('urlInput');
const keywordInput = document.getElementById('keywordInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const errorMsg = document.getElementById('errorMsg');
const loadingSection = document.getElementById('loadingSection');
const resultSection = document.getElementById('resultSection');
const loadingText = document.getElementById('loadingText');
const reanalyzeBtn = document.getElementById('reanalyzeBtn');

// 存储最近一次诊断结果，供导出PDF使用
let lastReportData = null;

// ======================== 状态颜色映射 ========================
const scoreColors = {
  excellent: '#52c41a',
  good: '#13c2c2',
  fair: '#faad14',
  poor: '#ff4d4f'
};

const statusText = {
  good: '良好',
  fair: '一般',
  poor: '较差'
};

function getScoreColor(score) {
  if (score >= 85) return scoreColors.excellent;
  if (score >= 70) return scoreColors.good;
  if (score >= 50) return scoreColors.fair;
  return scoreColors.poor;
}

function getGradeText(grade) {
  const map = { A: '优秀', B: '良好', C: '及格', D: '较差', F: '不及格' };
  return map[grade] || '待检测';
}

// ======================== 事件绑定 ========================
analyzeBtn.addEventListener('click', handleAnalyze);
urlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') handleAnalyze();
});
keywordInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') handleAnalyze();
});
reanalyzeBtn.addEventListener('click', () => {
  resultSection.style.display = 'none';
  urlInput.value = '';
  keywordInput.value = '';
  urlInput.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// 导出PDF & 打印按钮
document.getElementById('exportPdfBtn').addEventListener('click', exportPDF);
document.getElementById('printBtn').addEventListener('click', printReport);
document.getElementById('exportPdfBtn2').addEventListener('click', exportPDF);
document.getElementById('printBtn2').addEventListener('click', printReport);

// ======================== 主分析流程 ========================
async function handleAnalyze() {
  const url = urlInput.value.trim();
  const keyword = keywordInput.value.trim();
  errorMsg.style.display = 'none';

  if (!url) {
    showError('请输入要检测的网址');
    return;
  }

  // 切换到加载状态
  analyzeBtn.disabled = true;
  analyzeBtn.querySelector('.btn-text').textContent = '诊断中...';
  resultSection.style.display = 'none';
  loadingSection.style.display = 'block';

  // 加载步骤动画
  const steps = ['step1', 'step2', 'step3', 'step4'];
  const stepTexts = [
    '正在抓取页面内容...',
    '正在解析HTML结构...',
    '正在执行十维度分析...',
    '正在生成诊断报告...'
  ];

  let stepIndex = 0;
  const stepInterval = setInterval(() => {
    if (stepIndex < steps.length) {
      if (stepIndex > 0) {
        document.getElementById(steps[stepIndex - 1]).classList.remove('active');
        document.getElementById(steps[stepIndex - 1]).classList.add('done');
      }
      if (stepIndex < steps.length) {
        document.getElementById(steps[stepIndex]).classList.add('active');
        loadingText.textContent = stepTexts[stepIndex];
      }
      stepIndex++;
    }
  }, 1200);

  // 触发第一步
  document.getElementById('step1').classList.add('active');

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, searchKeyword: keyword })
    });

    const data = await response.json();

    clearInterval(stepInterval);

    if (!response.ok) {
      throw new Error(data.error || '诊断失败，请重试');
    }

    // 完成所有步骤
    steps.forEach(s => {
      const el = document.getElementById(s);
      el.classList.remove('active');
      el.classList.add('done');
    });
    loadingText.textContent = '诊断完成！';

    // 短暂延迟后显示结果
    setTimeout(() => {
      loadingSection.style.display = 'none';
      renderResult(data);
      resultSection.style.display = 'block';
      resultSection.scrollIntoView({ behavior: 'smooth' });
    }, 500);

  } catch (err) {
    clearInterval(stepInterval);
    loadingSection.style.display = 'none';
    showError(err.message);
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.querySelector('.btn-text').textContent = '开始诊断';
  }
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.style.display = 'block';
}

// ======================== 结果渲染 ========================
function renderResult(data) {
  // 保存数据供导出PDF使用
  lastReportData = data;

  // 报告头信息
  document.getElementById('reportUrl').textContent = data.url;
  document.getElementById('reportTime').textContent = data.timestamp;
  document.getElementById('reportTitle').textContent = '页面标题: ' + data.pageTitle;

  // 总评分仪表盘
  const gaugeFill = document.getElementById('gaugeFill');
  const totalScore = data.totalScore;
  const circumference = 2 * Math.PI * 85;
  const offset = circumference - (totalScore / 100) * circumference;
  const scoreColor = getScoreColor(totalScore);

  gaugeFill.style.stroke = scoreColor;
  document.getElementById('totalScore').textContent = totalScore;
  document.getElementById('totalScore').style.color = scoreColor;

  // 动画填充
  setTimeout(() => {
    gaugeFill.style.strokeDashoffset = offset;
  }, 100);

  // 评级
  document.getElementById('gradeLetter').textContent = data.grade;
  document.getElementById('gradeLetter').style.color = data.gradeColor;
  document.getElementById('gradeText').textContent = getGradeText(data.grade);
  document.querySelector('.grade-badge').style.background = data.gradeColor + '15';

  // 动态渲染维度条 + 详情卡
  const scoresContainer = document.getElementById('dimensionScores');
  scoresContainer.innerHTML = '';
  const detailContainer = document.getElementById('dimensionsDetail');
  detailContainer.innerHTML = '';

  const meta = data.dimensionMeta || [];
  meta.forEach((d, idx) => {
    const dim = data.dimensions[d.key];
    const score = dim.score;
    const color = getScoreColor(score);

    // 维度评分条卡片
    const item = document.createElement('div');
    item.className = 'dim-score-item';
    item.setAttribute('data-dim', d.key);
    item.innerHTML = `
      <div class="dim-icon">${d.icon}</div>
      <div class="dim-info">
        <div class="dim-name">${d.name} <span class="dim-weight">${d.weight}分</span></div>
        <div class="dim-bar-wrap">
          <div class="dim-bar" id="bar-${d.key}"></div>
        </div>
        <div class="dim-score-text" id="score-${d.key}">${score}分</div>
      </div>`;
    scoresContainer.appendChild(item);

    setTimeout(() => {
      const bar = document.getElementById('bar-' + d.key);
      bar.style.background = color;
      bar.style.width = score + '%';
    }, 200 + idx * 90);

    // 维度详情卡
    const card = document.createElement('div');
    card.className = 'dim-detail-card';
    card.id = 'detail-' + d.key;
    card.innerHTML = `
      <div class="dim-detail-header">
        <span class="dim-detail-icon">${d.icon}</span>
        <h3>${d.name}分析 <span class="dim-weight-tag">权重 ${d.weight} 分</span></h3>
        <span class="dim-detail-score" id="detail-score-${d.key}">${score}</span>
      </div>
      <div class="findings-list" id="findings-${d.key}"></div>
      <div class="suggestions-block">
        <h4 class="suggestions-title">🔧 整改建议</h4>
        <ul class="suggestions-list" id="suggestions-${d.key}"></ul>
      </div>`;
    detailContainer.appendChild(card);

    renderFindings(d.key, dim.findings);
    renderSuggestions(d.key, dim.suggestions);

    const ds = document.getElementById('detail-score-' + d.key);
    ds.style.color = color;
    ds.style.background = color + '15';
  });

  // 总体建议
  renderOverallSuggestions(data.overallSuggestions, data.dimensions, meta);
}

function renderFindings(dim, findings) {
  const container = document.getElementById('findings-' + dim);
  container.innerHTML = '';

  findings.forEach(f => {
    const item = document.createElement('div');
    item.className = 'finding-item';
    item.innerHTML = `
      <div class="finding-label">${f.item}</div>
      <div class="finding-value">${f.value}</div>
      <div class="finding-status ${f.status}">${statusText[f.status]}</div>
      <div class="finding-detail">${f.detail}</div>
    `;
    container.appendChild(item);
  });
}

function renderSuggestions(dim, suggestions) {
  const container = document.getElementById('suggestions-' + dim);
  container.innerHTML = '';

  suggestions.forEach(s => {
    const li = document.createElement('li');
    li.textContent = s;
    container.appendChild(li);
  });
}

function renderOverallSuggestions(suggestions, dimensions, meta) {
  const container = document.getElementById('overallSuggestions');

  if (!suggestions || suggestions.length === 0) {
    // 如果没有总体建议，根据各维度分数生成
    const allGood = (meta && meta.length)
      ? meta.every(d => dimensions[d.key].score >= 70)
      : Object.values(dimensions).every(d => d.score >= 70);
    if (allGood) {
      container.innerHTML = `
        <h3>✅ 总体评价</h3>
        <div class="overall-suggestion-item">落地页整体质量良好，各维度指标均达标，建议持续优化并定期复检</div>
      `;
    } else {
      container.innerHTML = `
        <h3>📌 优先整改事项</h3>
        <div class="overall-suggestion-item">建议优先改善得分较低的维度，全面提升落地页质量</div>
      `;
    }
    return;
  }

  container.innerHTML = `
    <h3>📌 优先整改事项</h3>
    ${suggestions.map(s => `<div class="overall-suggestion-item">${s}</div>`).join('')}
  `;
}

// ======================== 导出PDF（服务端生成 - 修复下载类型） ========================
async function exportPDF() {
  if (!lastReportData) {
    alert('请先执行落地页诊断，生成报告后再导出。');
    return;
  }

  const data = lastReportData;
  // 文件名格式：网址_360SEM落地页诊断报告.pdf
  const safeUrl = (data.url || 'landing-page').replace(/[\\/:*?"<>|\s]/g, '_').substring(0, 60);
  const filename = safeUrl + '_360SEM落地页诊断报告.pdf';

  // 禁用按钮，显示加载状态
  const exportBtns = document.querySelectorAll('#exportPdfBtn, #exportPdfBtn2');
  const originalTexts = [];
  exportBtns.forEach(btn => {
    btn.disabled = true;
    originalTexts.push(btn.innerHTML);
    btn.innerHTML = '<span>⏳</span> 生成中...';
  });

  try {
    // 服务端用 PDFKit 生成完整 PDF，前端以二进制方式接收
    const response = await fetch('/api/export-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || '服务端返回错误');
    }

    const buf = await response.arrayBuffer();
    if (!buf.byteLength) {
      throw new Error('生成的PDF内容为空');
    }

    // 关键修复：显式指定 Blob 的 MIME 为 application/pdf。
    const blob = new Blob([buf], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 3000);

  } catch (err) {
    alert('PDF导出失败: ' + err.message);
  } finally {
    exportBtns.forEach((btn, i) => {
      btn.disabled = false;
      if (originalTexts[i]) btn.innerHTML = originalTexts[i];
    });
  }
}

// ======================== 打印报告 ========================
function printReport() {
  window.print();
}

// ======================== 初始化 ========================
urlInput.focus();
