# ---- Base Node ----
# Pinned to a patched release for CVE-2026-111497 (Brotli decoder RCE) and the
# October 2026 Node.js security release. Keep base and production stages in sync.
FROM node:24.22.1-alpine AS base
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
FROM node:24.22.1-alpine AS production
WORKDIR /app

# Set Node.js options to handle larger HTTP headers (for NextAuth cookies)
ENV NODE_OPTIONS="--max-http-header-size=65536"

# pdftotext package
RUN apk add --no-cache poppler poppler-dev poppler-utils libxml2 libxslt zlib fontconfig ttf-dejavu \
    shared-mime-info libc6-compat glib zip unzip ghostscript curl gnumeric libreoffice

# Fonts LibreOffice lays translated slides out with: Carlito and Liberation
# have Calibri's and Arial's metrics, so text fits as it will in PowerPoint;
# Noto covers the scripts of the app's target languages (fontconfig picks
# them for a deck's Windows font names, e.g. Nirmala UI for Tamil). Package
# names checked against Alpine 3.24; together about 290 MB.
RUN apk add --no-cache font-carlito font-liberation font-noto font-noto-arabic font-noto-hebrew \
    font-noto-ethiopic font-noto-devanagari font-noto-bengali font-noto-tamil font-noto-telugu \
    font-noto-sinhala font-noto-thai font-noto-khmer font-noto-myanmar font-noto-cjk

RUN curl -L "https://github.com/jgm/pandoc/releases/download/3.9.0.2/pandoc-3.9.0.2-linux-amd64.tar.gz" | tar xz --strip-components 1 -C /usr/local

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