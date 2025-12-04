FROM denoland/deno:latest

WORKDIR /app

COPY main.ts .

RUN deno cache main.ts

EXPOSE 4693

CMD ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--unstable-kv", "main.ts"]
