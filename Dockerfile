FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data
ENV PORT=3000
EXPOSE 3000
CMD ["npm","start"]
