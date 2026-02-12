# ---- Base Node ----
FROM node:24-alpine AS base
WORKDIR /app
COPY package*.json ./

# Install dependencies for Pandoc
RUN apk add --no-cache curl

# ---- Dependencies ----
FROM base AS dependencies
RUN npm ci

# ---- Test ----
FROM dependencies AS test
COPY . .
RUN npm run coverage

# ---- Build ----
FROM dependencies AS build
COPY . .

ARG BUILD
ENV NEXT_PUBLIC_BUILD=$BUILD
ARG ENV=prod
ENV NEXT_PUBLIC_ENV=$ENV

RUN npm run build

# ---- Production ----
FROM node:24-alpine AS production
WORKDIR /app

# Set Node.js options to handle larger HTTP headers (for NextAuth cookies)
ENV NODE_OPTIONS="--max-http-header-size=65536"

# pdftotext package
RUN apk add --no-cache poppler poppler-dev poppler-utils libxml2 libxslt zlib fontconfig ttf-dejavu \
    shared-mime-info libc6-compat glib zip unzip ghostscript curl gnumeric libreoffice

RUN curl -L "https://github.com/jgm/pandoc/releases/download/3.2.1/pandoc-3.2.1-linux-amd64.tar.gz" | tar xz --strip-components 1 -C /usr/local

RUN chmod 1777 /tmp

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package*.json ./
COPY --from=build /app/next.config.js ./next.config.js

# Expose the port the app will run on
EXPOSE 3000

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

# Start the application
CMD ["npm", "start"]