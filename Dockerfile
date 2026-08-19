FROM node:24-alpine AS development-dependencies-env
COPY . /app
WORKDIR /app
RUN npm ci

FROM node:24-alpine AS production-dependencies-env
COPY ./package.json package-lock.json /app/
# O postinstall roda `prisma generate`, que precisa do schema.
COPY ./prisma /app/prisma
WORKDIR /app
RUN npm ci --omit=dev

FROM node:24-alpine AS build-env
COPY . /app/
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
WORKDIR /app
RUN npm run build

FROM node:24-alpine
# O relógio do container decide o que é "hoje" no filtro de vendas e nos
# relatórios. O Alpine roda em UTC, e sem tzdata a variável TZ não resolve nome
# nenhum — o resultado era o movimento das últimas três horas do dia caindo no
# dia seguinte, no fechamento de caixa de quem confere.
RUN apk add --no-cache tzdata
ENV TZ=America/Sao_Paulo
COPY ./package.json package-lock.json /app/
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build
WORKDIR /app
CMD ["npm", "run", "start"]
