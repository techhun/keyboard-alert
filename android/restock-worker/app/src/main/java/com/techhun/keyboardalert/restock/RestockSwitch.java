package com.techhun.keyboardalert.restock;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.util.AttributeSet;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.animation.PathInterpolator;

/**
 * 앱 톤에 맞춰 직접 그리는 켜기/끄기 스위치.
 * 트랙 46×28dp, 터치 영역은 48dp를 채운다.
 */
final class RestockSwitch extends View {
    interface Listener {
        void onCheckedChanged(boolean checked);
    }

    private final Paint trackPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint thumbPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final int onColor;
    private final int offColor;
    private final float trackWidth;
    private final float trackHeight;
    private final float thumbInset;

    private boolean checked;
    private float position;
    private Listener listener;
    private ValueAnimator animator;

    RestockSwitch(Context context) {
        this(context, null);
    }

    RestockSwitch(Context context, AttributeSet attrs) {
        super(context, attrs);
        onColor = Ui.color(context, R.color.restock_accent);
        offColor = Ui.color(context, R.color.restock_track_off);
        thumbPaint.setColor(Ui.color(context, R.color.restock_surface));
        trackWidth = Ui.dp(context, 46);
        trackHeight = Ui.dp(context, 28);
        thumbInset = Ui.dp(context, 3);
        setClickable(true);
        setFocusable(true);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
        updateContentDescription();
    }

    /** 화면 갱신용. 사용자가 방금 누른 상태와 같으면 진행 중인 애니메이션을 건드리지 않는다. */
    void bind(boolean value) {
        if (checked == value) {
            if (animator == null || !animator.isRunning()) {
                position = value ? 1f : 0f;
                invalidate();
            }
            return;
        }
        cancelAnimation();
        checked = value;
        position = value ? 1f : 0f;
        updateContentDescription();
        invalidate();
    }

    void setListener(Listener value) {
        listener = value;
    }

    @Override
    public boolean performClick() {
        super.performClick();
        checked = !checked;
        updateContentDescription();
        if (listener != null) listener.onCheckedChanged(checked);
        animateTo(checked ? 1f : 0f);
        return true;
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int width = resolveSize(Math.round(trackWidth) + 2, widthMeasureSpec);
        int height = resolveSize(Ui.dim(getContext(), R.dimen.restock_switch_height), heightMeasureSpec);
        setMeasuredDimension(width, height);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float centerX = getWidth() / 2f;
        float centerY = getHeight() / 2f;
        float left = centerX - trackWidth / 2f;
        float top = centerY - trackHeight / 2f;
        float radius = trackHeight / 2f;

        trackPaint.setColor(blend(offColor, onColor, position));
        canvas.drawRoundRect(left, top, left + trackWidth, top + trackHeight, radius, radius, trackPaint);

        float thumbRadius = radius - thumbInset;
        float startX = left + radius;
        float endX = left + trackWidth - radius;
        canvas.drawCircle(startX + (endX - startX) * position, centerY, thumbRadius, thumbPaint);
    }

    @Override
    public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(info);
        info.setClassName("android.widget.Switch");
        info.setCheckable(true);
        info.setChecked(checked);
    }

    @Override
    protected void onDetachedFromWindow() {
        cancelAnimation();
        super.onDetachedFromWindow();
    }

    private void animateTo(float target) {
        cancelAnimation();
        animator = ValueAnimator.ofFloat(position, target);
        animator.setDuration(160L);
        animator.setInterpolator(new PathInterpolator(0.22f, 1f, 0.36f, 1f));
        animator.addUpdateListener(animation -> {
            position = (float) animation.getAnimatedValue();
            invalidate();
        });
        animator.start();
    }

    private void cancelAnimation() {
        if (animator != null) {
            animator.cancel();
            animator = null;
        }
    }

    private void updateContentDescription() {
        setContentDescription(checked ? "알림 켜짐" : "알림 꺼짐");
    }

    private static int blend(int from, int to, float amount) {
        float value = Math.max(0f, Math.min(1f, amount));
        int red = Math.round(Color.red(from) + (Color.red(to) - Color.red(from)) * value);
        int green = Math.round(Color.green(from) + (Color.green(to) - Color.green(from)) * value);
        int blue = Math.round(Color.blue(from) + (Color.blue(to) - Color.blue(from)) * value);
        return Color.rgb(red, green, blue);
    }
}
