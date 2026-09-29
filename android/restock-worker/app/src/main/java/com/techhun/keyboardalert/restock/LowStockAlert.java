package com.techhun.keyboardalert.restock;

final class LowStockAlert {
    private LowStockAlert() {}

    static boolean shouldNotify(Integer previous, int current, int threshold, boolean restocked) {
        return !restocked && current > 0 && current <= threshold
            && (previous == null || previous > threshold);
    }
}
