FROM denoland/deno:2.2.12

WORKDIR /app

VOLUME /app/dat
VOLUME /app/data

COPY . .

RUN rm -f deno.lock && deno install --allow-import

CMD [ "deno", "run", "-A", "main.ts" ]

