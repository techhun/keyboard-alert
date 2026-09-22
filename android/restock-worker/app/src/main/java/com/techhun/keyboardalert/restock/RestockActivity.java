package com.techhun.keyboardalert.restock;

import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

public class RestockActivity extends MainActivity {
    private static final int TEXT = Color.rgb(25, 31, 40);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        decorateBrand();
    }

    private void decorateBrand() {
        View content = findViewById(android.R.id.content);
        if (!(content instanceof ViewGroup contentGroup) || contentGroup.getChildCount() == 0) return;
        View rootView = contentGroup.getChildAt(0);
        if (!(rootView instanceof LinearLayout root) || root.getChildCount() == 0) return;
        View headerView = root.getChildAt(0);
        if (!(headerView instanceof LinearLayout header) || header.getChildCount() < 4) return;

        View iconView = header.getChildAt(0);
        if (iconView instanceof ImageView icon) {
            icon.setImageResource(R.drawable.restock_icon);
            icon.setLayoutParams(new LinearLayout.LayoutParams(dp(42), dp(42)));
        }

        if (header.getChildCount() > 1
            && header.getChildAt(1) instanceof TextView existing
            && "Restock".contentEquals(existing.getText())) return;

        TextView brand = new TextView(this);
        brand.setText("Restock");
        brand.setTextSize(22f);
        brand.setTextColor(TEXT);
        brand.setTypeface(null, Typeface.BOLD);
        LinearLayout.LayoutParams brandLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        brandLp.leftMargin = dp(10);
        header.addView(brand, 1, brandLp);
        Motion.enter(brand, 15L);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
