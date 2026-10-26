FROM node:24-alpine

WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/signaling.cjs ./signaling.cjs

ENV NODE_ENV=production
ENV SIGNALING_HOST=0.0.0.0
ENV SIGNALING_PORT=8787

EXPOSE 8787
USER node
CMD ["node", "signaling.cjs"]