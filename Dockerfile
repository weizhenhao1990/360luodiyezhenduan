# 使用官方 Node 20 镜像
FROM node:20-slim

# 工作目录
WORKDIR /app

# 先拷贝依赖清单，利用层缓存
COPY package.json ./
RUN npm install --production

# 拷贝应用代码与自带字体
COPY server.js ./
COPY public ./public
COPY fonts ./fonts

# 暴露端口（运行时用环境变量 PORT 覆盖）
ENV PORT=3210
EXPOSE 3210

# 启动
CMD ["node", "server.js"]
