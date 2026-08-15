-- 同一張訂單同時只能有一筆 pending 或 approved 的退票申請
-- （rejected 允許重新申請，不受限）。讓 createRefundRequest 的
-- read-then-create 在併發下有 DB 層的兜底：兩個併發請求都通過
-- 「沒有既有 pending/approved 申請」的檢查後同時 create，其中一個
-- 會撞上這個 partial unique index 而失敗（P2002），程式碼再捕捉後
-- 回報 REFUND_ALREADY_REQUESTED，與 payments_order_id_pending_key
-- 對 createPayment 的做法同一模式。
CREATE UNIQUE INDEX "refund_requests_order_id_pending_approved_key" ON "refund_requests"("order_id") WHERE status IN ('pending', 'approved');
