# syntax=docker/dockerfile:1

# --- Abhängigkeiten --------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# --- Build -----------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- Laufzeit --------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Labels werden hier abgelegt (DHL hält sie nur ~3 Tage vor)
ENV STORAGE_DIR=/app/storage

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Next.js im Standalone-Modus bringt nur die tatsächlich benötigten Module mit.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Migrationen und Seed laufen beim Start - dafür Skripte und SQL mitnehmen.
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/src/db/migrations ./src/db/migrations
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/postgres ./node_modules/postgres
COPY --chown=nextjs:nodejs docker/entrypoint.sh ./entrypoint.sh

# Zeilenenden normalisieren und ausführbar machen: Windows-Checkouts liefern
# sonst CRLF, woran der Start im Container scheitert.
RUN sed -i 's/\r$//' ./entrypoint.sh && chmod +x ./entrypoint.sh \
 && mkdir -p /app/storage && chown -R nextjs:nodejs /app/storage
USER nextjs

EXPOSE 3000
ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "server.js"]
