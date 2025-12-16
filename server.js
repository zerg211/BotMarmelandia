diff --git a/server.js b/server.js
--- a/server.js
+++ b/server.js
@@
-    const item = Array.isArray(payload?.items) ? payload.items[0] : null;
-    const categoryId = item?.category_id ?? item?.categoryId;
-    const price = item?.price ?? item?.prices?.price ?? item?.prices?.marketing_price;
-    if (!categoryId) return res.status(400).json({ error: "missing_category_id" });
-    if (!Number.isFinite(Number(price)) || Number(price) <= 0) {
-      // Для фиксированной комиссии по категории это не нужно, но если кто-то дернёт endpoint — защитимся
-      return res.status(400).json({ error: "missing_or_invalid_price" });
-    }
-
-    const price = Number(item?.price);
-    const categoryId = Number(item?.category_id);
-    if (!item || !Number.isFinite(price) || price <= 0 || !Number.isFinite(categoryId) || categoryId <= 0) {
+    const item = Array.isArray(payload?.items) ? payload.items[0] : null;
+    const categoryId = item?.category_id ?? item?.categoryId;
+    const rawPrice = item?.price ?? item?.prices?.price ?? item?.prices?.marketing_price;
+    const price = Number(rawPrice);
+    if (!categoryId) return res.status(400).json({ error: "missing_category_id" });
+    if (!Number.isFinite(price) || price <= 0) {
+      // Для фиксированной комиссии по категории это не нужно, но если кто-то дернёт endpoint — защитимся
+      return res.status(400).json({ error: "missing_or_invalid_price" });
+    }
+
+    const categoryIdNum = Number(categoryId);
+    if (!item || !Number.isFinite(categoryIdNum) || categoryIdNum <= 0) {
       return res.status(400).json({
         error: "invalid_input",
         details: {
           has_items: Array.isArray(payload?.items),
-          price: item?.price,
-          category_id: item?.category_id,
+          price: rawPrice,
+          category_id: categoryId,
           delivery_schema: item?.delivery_schema,
         },
       });
     }
