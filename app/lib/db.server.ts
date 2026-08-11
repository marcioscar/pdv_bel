import "~/lib/env.server"

import { PrismaClient } from "@prisma/client"

declare global {
  var __db: PrismaClient | undefined
}

// Em dev o HMR recria o módulo a cada troca; sem o singleton cada reload abre
// um novo pool de conexões contra o Mongo.
let db: PrismaClient

if (process.env.NODE_ENV === "production") {
  db = new PrismaClient()
} else {
  if (!global.__db) {
    global.__db = new PrismaClient()
  }
  db = global.__db
}

export { db }
