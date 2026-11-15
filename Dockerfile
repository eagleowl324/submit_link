FROM node:22-alpine

WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY shared ./shared
COPY public ./public

# 제출 내용은 /data 에 저장됩니다. 볼륨을 연결하지 않으면 컨테이너를 지울 때 함께 사라집니다.
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 3000

CMD ["node", "server.js"]
