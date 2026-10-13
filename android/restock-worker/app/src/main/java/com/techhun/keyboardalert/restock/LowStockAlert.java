package com.techhun.keyboardalert.restock;

final class LowStockAlert {
    private LowStockAlert() {}

    static boolean shouldNotify(Integer previous, int current, int threshold,
                                boolean restocked, Integer restockQuantity) {
        return current > 0 && current <= threshold
            && (restocked || previous == null || previous > threshold
                || (restockQuantity != null && current < restockQuantity));
    }
}
