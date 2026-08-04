# 360SEM 落地页诊断工具 —— 云端部署指南

一个输入网址即可诊断落地页（加载速度 / 转化表单 / 联系方式 / 产品介绍）并生成评分报告 + PDF 的工具。
本目录已是**可直接部署**的版本：端口走环境变量、自带中文字体、依赖已固定。

---

## 一、项目结构
```
landing-page-diagnostic/
├── server.js            # Node.js + Express 后端（抓取页面 / 分析 / 生成PDF）
├── package.json         # 依赖与启动脚本（start: node server.js）
├── public/              # 前端（index.html / style.css / script.js）
├── fonts/cn.ttf         # 自带中文字体（黑体），部署到 Linux 也不会乱码
├── Dockerfile           # 容器化部署
├── .gitignore
├── render.yaml          # Render 一键部署配置
└── fly.toml             # Fly.io 部署配置
```

## 二、本地运行（验证用）
```bash
npm install
npm start          # 默认 http://localhost:3210
```
设置端口：`PORT=8080 npm start`

## 三、部署到云平台（任选其一）

### 方案 A：Render（最省事，推荐）
1. 把本目录推到 GitHub 仓库。
2. 打开 https://render.com → New → Web Service → 关联仓库。
3. 配置：
   - Build Command: `npm install`
   - Start Command: `npm start`
   - 环境变量：**无需任何配置**（端口自动注入，字体已自带）。
4. 部署完成后，Render 会给你一个 `xxx.onrender.com` 的公网地址，所有人都能访问。

> 也可直接用仓库里的 `render.yaml`：在 Render 选择 "Blueprint" 方式导入仓库即可自动识别。

### 方案 B：Fly.io（全球边缘节点，速度快）
1. 安装 flyctl 并登录：`fly auth login`
2. 在目录下执行：`fly launch`（会自动读取 fly.toml）
3. 部署：`fly deploy`
4. 完成后得到 `xxx.fly.dev` 公网地址。

### 方案 C：阿里云 / 腾讯云 轻量应用服务器（或任意 Linux VPS）
```bash
# 1. 安装 Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 上传项目并安装依赖
cd /opt/landing-page-diagnostic
npm install --production

# 3. 用 pm2 守护进程（保证 7×24 在线、崩溃自动重启）
sudo npm install -g pm2
pm2 start server.js --name landing-diag
pm2 save && pm2 startup

# 4. 开放端口（默认 3210，或改 Nginx 反代到 80/443 + 域名 + HTTPS）
```
如用 Nginx 反代，把 `proxy_pass http://127.0.0.1:3210;` 即可，再用域名 + SSL 证书对外提供 HTTPS。

### 方案 D：Docker 容器（任何支持容器的平台）
```bash
docker build -t landing-diag .
docker run -d -p 3210:3210 --name landing-diag landing-diag
# 平台注入的 PORT 会被容器内的 CMD 读取；如需固定端口用 -e PORT=3210
```

---

## 四、关于中文字体（重要）
- 项目已自带 `fonts/cn.ttf`（黑体），**部署到任何 Linux 主机 PDF 中文都不会乱码**，无需额外安装字体。
- 如需替换字体：把你的中文字体（TTF/OTF/TTC）放到 `fonts/cn.ttf`，或设置环境变量
  `FONT_PATH=/path/to/your-font.ttf`。
- 若两者都缺失，服务仍能运行，但 PDF 中文会显示为方块（启动时会打印 WARN 提示）。

## 五、环境变量
| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3210` | 服务监听端口，云平台自动注入 |
| `FONT_PATH` | 无 | 指定自定义中文字体路径（可选） |
| `HOST` | `0.0.0.0` | 已在代码中默认绑定，无需设置 |

## 六、常见问题
- **502 / 无法访问**：确认进程在跑（`pm2 ls` / `docker ps`），且云平台"健康检查"或端口指向正确。
- **PDF 中文乱码**：检查 `fonts/cn.ttf` 是否随项目一起上传/打包（Docker 已 COPY 进镜像）。
- **抓取某些网站超时/失败**：目标站可能有反爬或需要 HTTPS；工具默认先试 http 再试 https，并在 15s 超时内返回友好错误。
