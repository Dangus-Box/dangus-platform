FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598
WORKDIR /workspace/examples/sqlite
COPY packages/server /workspace/packages/server
COPY packages/web /workspace/packages/web
COPY packages/native /workspace/packages/native
COPY examples/sqlite ./
RUN bun install --frozen-lockfile && rm -rf /workspace/packages/server/node_modules && ln -s /workspace/examples/sqlite/node_modules /workspace/packages/server/node_modules
RUN rm -rf /workspace/packages/web/node_modules && ln -s /workspace/examples/sqlite/node_modules /workspace/packages/web/node_modules
RUN bun run --bun vite build --config apps/web/vite.config.ts
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "apps/web/server.ts"]
