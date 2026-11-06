FROM node:22.17.1-bookworm@sha256:37ff334612f77d8f999c10af8797727b731629c26f2e83caa6af390998bdc49c
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ pkg-config libxi-dev libglu1-mesa-dev libglew-dev libcairo2-dev libjpeg-dev libpango1.0-dev libgif-dev librsvg2-dev xvfb xauth libgl1-mesa-dri && rm -rf /var/lib/apt/lists/*
WORKDIR /renderer
COPY package.json package-lock.json ./
RUN npm ci
COPY server.cjs ./
RUN groupadd --gid 10002 renderer && useradd --uid 10002 --gid 10002 --no-create-home renderer
USER 10002:10002
ENV LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe NODE_ENV=production
CMD ["xvfb-run","-a","node","server.cjs"]
