package com.techhun.keyboardalert.restock;

import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 화면 코드가 공유하는 디자인 토큰 접근자.
 * 색·치수·타입 스케일은 res/values(colors.xml, dimens.xml)에서만 정의한다.
 */
final class Ui {
    private Ui() {}

    static int dp(Context context, float value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    static int dim(Context context, int dimenRes) {
        return context.getResources().getDimensionPixelSize(dimenRes);
    }

    static int color(Context context, int colorRes) {
        return context.getColor(colorRes);
    }

    static TextView text(Context context, CharSequence value, int textSizeRes, int color, int style) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextSize(
            TypedValue.COMPLEX_UNIT_PX,
            context.getResources().getDimension(textSizeRes)
        );
        view.setTextColor(color);
        view.setTypeface(null, style);
        view.setIncludeFontPadding(false);
        return view;
    }

    /** 다이얼로그처럼 sp 값을 그대로 넘겨야 하는 화면이 쓰는 통로. */
    static TextView textSp(Context context, CharSequence value, float sp, int color, int style) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(color);
        view.setTypeface(null, style);
        view.setIncludeFontPadding(false);
        return view;
    }

    /** 흰 카드(모서리 20dp). 패딩은 호출하는 쪽이 정한다. */
    static LinearLayout surface(Context context) {
        LinearLayout view = new LinearLayout(context);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setBackground(radiusDrawable(
            Ui.color(context, R.color.restock_surface),
            context.getResources().getDimension(R.dimen.restock_radius_card)
        ));
        return view;
    }

    static LinearLayout surface(Context context, int radiusDp, int paddingDp) {
        LinearLayout view = new LinearLayout(context);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setPadding(dp(context, paddingDp), dp(context, paddingDp),
            dp(context, paddingDp), dp(context, paddingDp));
        view.setBackground(roundRect(context, color(context, R.color.restock_surface), radiusDp));
        return view;
    }

    static GradientDrawable roundRect(Context context, int fillColor, float radiusDp) {
        return radiusDrawable(fillColor, dp(context, radiusDp));
    }

    static GradientDrawable outline(
        Context context,
        int fillColor,
        int strokeColor,
        float radiusDp,
        float strokeDp
    ) {
        GradientDrawable drawable = roundRect(context, fillColor, radiusDp);
        drawable.setStroke(Math.max(1, dp(context, strokeDp)), strokeColor);
        return drawable;
    }

    static View dot(Context context, int color, float sizeDp) {
        View view = new View(context);
        view.setBackground(roundRect(context, color, sizeDp / 2f));
        return view;
    }

    static View hairline(Context context, int color) {
        View view = new View(context);
        view.setBackgroundColor(color);
        return view;
    }

    static LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
    }

    static LinearLayout.LayoutParams wrapWrap() {
        return new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
    }

    static LinearLayout.LayoutParams fixed(int widthPx, int heightPx) {
        return new LinearLayout.LayoutParams(widthPx, heightPx);
    }

    static LinearLayout.LayoutParams row(float weight, int heightPx) {
        return new LinearLayout.LayoutParams(0, heightPx, weight);
    }

    private static GradientDrawable radiusDrawable(int fillColor, float radiusPx) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fillColor);
        drawable.setCornerRadius(radiusPx);
        return drawable;
    }
}
