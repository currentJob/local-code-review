/** 처음 온 사람이 바로 눌러 볼 예제. 흔한 실수를 일부러 넣었다(SQL 조립, 빠진 await, 비밀값 로그, 예외 삼킴). */
export const SAMPLE_DIFF = `diff --git a/src/users.ts b/src/users.ts
index 3f2a1c0..9b7e4d2 100644
--- a/src/users.ts
+++ b/src/users.ts
@@ -1,16 +1,21 @@
 import { db } from './db'
 import { logger } from './logger'
 
-export async function findUser(id: number) {
-  return db.query('SELECT * FROM users WHERE id = $1', [id])
+export async function findUser(name: string) {
+  const rows = await db.query(\`SELECT * FROM users WHERE name = '\${name}'\`)
+  return rows[0]
 }
 
 export async function login(name: string, password: string) {
   const user = await findUser(name)
-  if (!user) throw new Error('not found')
-  return checkPassword(user, password)
+  logger.info(\`login attempt \${name} / \${password}\`)
+  const ok = checkPassword(user, password)
+  if (ok) {
+    db.query('UPDATE users SET last_login = now() WHERE id = $1', [user.id])
+  }
+  return ok
 }
 
-export function pageCount(total: number, size: number) {
-  return Math.ceil(total / size)
+export function pageCount(total: number, size: number) {
+  return Math.floor(total / size)
 }
diff --git a/jobs/sync.py b/jobs/sync.py
index 71c9e10..a0d4b55 100644
--- a/jobs/sync.py
+++ b/jobs/sync.py
@@ -10,4 +10,8 @@ def sync_orders(client, since):
     orders = client.fetch_orders(since=since)
     for order in orders:
-        save(order)
+        try:
+            save(order)
+        except:
+            pass
+    open("last_sync.txt", "w").write(str(since))
     return len(orders)
diff --git a/package-lock.json b/package-lock.json
index 1111111..2222222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
 {
-  "version": "1.0.0",
+  "version": "1.0.1",
 }
`
