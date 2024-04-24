# base node image
FROM node:18-bullseye-slim AS base

# set for base and all layer that inherit from it
ENV NODE_ENV production

# Install sqlite and openssl for Prisma
RUN apt-get update && apt-get install -y openssl sqlite3

# Install all node_modules, including dev dependencies
FROM base AS deps

WORKDIR /app

ADD package.json ./
RUN npm install --include=dev

# Setup production node_modules
FROM base AS production-deps

WORKDIR /app

COPY --from=deps /app/node_modules /app/node_modules
ADD package.json ./
RUN npm prune --omit=dev

# Build the app for production
FROM base AS build

WORKDIR /app

COPY --from=deps /app/node_modules /app/node_modules

ADD prisma .
RUN npx prisma generate

ADD . .
RUN npm run build

# Finally, build the production image with minimal footprint
FROM base

# Set production environment variables
ENV DATABASE_URL=file:/app/data/sqlite.db
ENV PORT="3000"
ENV NODE_ENV="production"

# add shortcut for connecting to database CLI
RUN echo "#!/bin/sh\nset -x\nsqlite3 \$DATABASE_URL" > /usr/local/bin/database-cli && chmod +x /usr/local/bin/database-cli

WORKDIR /app

# Copy production node_modules and the generated Prisma client
COPY --from=production-deps /app/node_modules /app/node_modules
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma

# Copy the built app and the folders and files needed in production
COPY --from=build /app/build /app/build
COPY --from=build /app/public /app/public
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/content /app/content
COPY --from=build /app/meta /app/meta
COPY --from=build /app/prisma /app/prisma
COPY --from=build /app/scripts /app/scripts

CMD ["npm", "start"]