/*
  Warnings:

  - A unique constraint covering the columns `[transaction_id]` on the table `payments` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "payments_transaction_id_key" ON "payments"("transaction_id");

-- 同一張訂單同時只能有一筆 pending 付款（多筆 failed / 最多一筆 success 不受影響）。
-- 讓 createPayment 的 read-then-create 在併發下有 DB 層的兜底：兩個並發請求
-- 都通過「沒有既有 pending 付款」的檢查後同時 create，其中一個會撞上這個
-- partial unique index 而失敗（P2002），程式碼再重新查詢回同一筆。
CREATE UNIQUE INDEX "payments_order_id_pending_key" ON "payments"("order_id") WHERE status = 'pending';
