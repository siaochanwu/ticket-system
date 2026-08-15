#  Fastify 高流量搶票系統 — 完整架構設計

## 目錄

1. [系統架構總覽](#一系統架構總覽)
2. [專案目錄結構](#二專案目錄結構)


---

## 一、系統架構總覽

```
                            ┌─────────────────┐
                            │   CloudFlare    │
                            │   CDN + WAF     │
                            └────────┬────────┘
                                     │
                            ┌────────▼────────┐
                            │     Nginx       │
                            │  Load Balancer  │
                            └────────┬────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
     ┌────────▼────────┐   ┌────────▼────────┐   ┌────────▼────────┐
     │ Fastify Node 1  │   │ Fastify Node 2  │   │ Fastify Node N  │
     └────────┬────────┘   └────────┬────────┘   └────────┬────────┘
              │                      │                      │
              └──────────────────────┼──────────────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        │                            │                            │
┌───────▼───────┐          ┌─────────▼─────────┐         ┌───────▼───────┐
│ Redis Cluster │          │    RabbitMQ /     │         │  PostgreSQL   │
│ • 庫存快取     │          │      Kafka        │         │  • 主從複製    │
│ • 分散式鎖     │          │ • 訂單處理         │         │  • 讀寫分離    │
│ • 排隊系統     │          │ • 通知推送         │         │               │
│ • Session     │          │ • 超時檢查         │         │               │
└───────────────┘          └───────────────────┘         └───────────────┘
```

### 技術選型

| 層級 | 技術 | 用途 |
|------|------|------|
| Web Framework | Fastify | 高效能 Node.js 框架 |
| Database | PostgreSQL | 主要資料儲存 |
| Cache / Lock | Redis | 快取、分散式鎖、排隊系統 |
| Message Queue | RabbitMQ | 非同步任務處理 |
| Load Balancer | Nginx | 負載均衡、限流 |

## 購票流程 API

| Method | Endpoint | 說明 |
|--------|----------|------|
| POST | `/api/tickets/lock` | 鎖定座位（手動選位） |
| POST | `/api/tickets/auto-select` | 自動選位 |
| POST | `/api/orders` | 建立訂單 |
| POST | `/api/orders/:orderId/cancel` | 取消訂單 |
| POST | `/api/payments` | 建立付款（回傳 mock 金流連結） |
| POST | `/api/payments/callback/mock` | mock 金流 webhook（HMAC 驗簽 + 冪等） |
| GET | `/api/payments/:paymentId/status` | 查詢付款狀態 |
| GET | `/api/my-tickets` | 我的電子票券 |
| GET | `/api/my-tickets/:ticketId/qrcode` | 取得已簽章的 QR payload |
| POST | `/api/refunds` | 申請退票 |
| POST | `/api/admin/refunds/:refundId/approve` | 核准退票（admin） |

## 背景 Worker

逾期未付款的訂單由獨立 worker process 回收，每一輪會處理兩類回收目標：

1. **逾期未付款訂單**（`expireOverdueOrders`）：將 `status = 'pending'` 且 `expires_at` 已過期的訂單標記為 `expired`，釋放對應座位回 `available`，並清除該座位持有者名下的 Redis `seat:lock:{seatId}` 鍵。
2. **孤兒座位鎖**（`reclaimAbandonedSeatLocks`）：座位 `status = 'locked'` 但 `locked_until` 已過期、且找不到任何依附的 `pending` / `paid` 訂單，一併釋放回 `available`，避免使用者選位後未送出訂單而讓座位卡死。這類回收刻意不刪 Redis 座位鎖——符合條件的座位通常 Redis 鎖早已自然過期，強制刪除反而可能誤刪別人剛合法取得的新鎖。

多實例部署時以 Redis `SET NX` leader lock（`LEADER_LOCK_KEY`）確保同一輪只有一個實例在處理，其餘實例取不到鎖會靜默略過，這是正常行為而非錯誤。

```bash
npm run worker        # 開發模式
npm run worker:start  # 編譯後執行
```

## 防超賣機制

系統採用兩層防護，同時作用於訂單 `pending` 期間：

1. **Redis 座位鎖**（`seat:lock:{seatId}`）：搶位當下即時卡位，TTL 對齊訂單付款期限。
2. **DB 座位狀態**（`seats.status = 'locked'`）：`lockSeats` 會在同一次交易中檢查座位狀態並在 `updateMany` 加上 `status = 'available'` 的守衛條件，確保「先查後寫」不會被併發請求繞過，座位不會被兩張訂單同時持有。

會刪除 Redis 座位鎖的情況共有五種：付款成功、使用者取消訂單、worker 判定訂單逾期（`expireOverdueOrders`）、使用者主動釋放選位（`DELETE /api/tickets/lock/:lockId`，`unlockSeats`），以及 `lockSeats` 選位失敗時的回滾。前三者共用同一個「比對持有者後才刪」的 `releaseSeatLockIfOwnedBy`；`unlockSeats` 與 `lockSeats` 回滾走的是同一個原則，各自內建同款比對邏輯。孤兒座位鎖回收（`reclaimAbandonedSeatLocks`）只處理 DB 座位狀態，刻意不動 Redis。

---