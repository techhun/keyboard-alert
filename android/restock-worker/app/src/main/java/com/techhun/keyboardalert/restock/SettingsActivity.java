package com.techhun.keyboardalert.restock;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.WindowInsets;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class SettingsActivity extends Activity {
    private static final int BG = Color.rgb(247, 248, 250);
    private static final int WHITE = Color.WHITE;
    private static final int TEXT = Color.rgb(25, 31, 40);
    private static final int SUB = Color.rgb(139, 149, 161);
    private static final int BLUE = Color.rgb(49, 130, 246);
    private static final int BLUE_SOFT = Color.rgb(235, 244, 255);
    private static final int FIELD = Color.rgb(242, 244, 246);
    private static final int GREEN = Color.rgb(20, 180, 110);
    private static final int GREEN_SOFT = Color.rgb(232, 249, 241);
    private static final int[] VALUES = {15, 30, 60};
    private static final String[] LABELS = {"15초", "30초", "60초"};
    private static final int REQUEST_EXPORT = 9201;
    private static final int REQUEST_IMPORT = 9202;

    private TextView[] chips;
    private TextView notificationStatus;
    private TextView batteryStatus;
    private TextView diagnosticStatus;
    private int interval;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        interval = MonitorPrefs.intervalSeconds(this);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BG);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int top;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                var bars = insets.getInsets(WindowInsets.Type.systemBars());
                top = bars.top;
                bottom = bars.bottom;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(dp(20), top + dp(10), dp(20), bottom + dp(24));
            return insets;
        });
        scroll.addView(root, new ScrollView.LayoutParams(
            ScrollView.LayoutParams.MATCH_PARENT,
            ScrollView.LayoutParams.WRAP_CONTENT
        ));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(header, matchWrap());

        TextView back = text("‹", 34, TEXT, Typeface.NORMAL);
        back.setGravity(Gravity.CENTER);
        back.setPadding(0, 0, dp(14), 0);
        back.setOnClickListener(v -> finish());
        Motion.press(back);
        header.addView(back, new LinearLayout.LayoutParams(dp(40), dp(46)));
        header.addView(text("설정", 24, TEXT, Typeface.BOLD));

        LinearLayout intervalCard = surface(20, 18);
        LinearLayout.LayoutParams intervalLp = matchWrap();
        intervalLp.topMargin = dp(22);
        root.addView(intervalCard, intervalLp);
        intervalCard.addView(text("조회 주기", 15, TEXT, Typeface.BOLD));

        LinearLayout intervalRow = new LinearLayout(this);
        intervalRow.setPadding(0, dp(12), 0, 0);
        intervalCard.addView(intervalRow, matchWrap());
        chips = new TextView[VALUES.length];
        for (int i = 0; i < VALUES.length; i++) {
            final int value = VALUES[i];
            TextView chip = text(LABELS[i], 14, SUB, Typeface.BOLD);
            chip.setGravity(Gravity.CENTER);
            Motion.press(chip);
            chip.setOnClickListener(v -> {
                interval = value;
                MonitorPrefs.prefs(this).edit().putInt(MonitorPrefs.KEY_INTERVAL, value).apply();
                refreshChips();
                Motion.selection(chip);
            });
            chips[i] = chip;
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(46), 1f);
            if (i > 0) lp.leftMargin = dp(8);
            intervalRow.addView(chip, lp);
        }
        refreshChips();

        TextView intervalNote = text("알림이 켜진 상품들은 이 주기 안에서 나눠서 확인해요.", 12, SUB, Typeface.NORMAL);
        intervalNote.setPadding(0, dp(10), 0, 0);
        intervalCard.addView(intervalNote);

        LinearLayout notificationCard = surface(20, 18);
        LinearLayout.LayoutParams notificationLp = matchWrap();
        notificationLp.topMargin = dp(10);
        root.addView(notificationCard, notificationLp);

        LinearLayout notificationHeader = new LinearLayout(this);
        notificationHeader.setGravity(Gravity.CENTER_VERTICAL);
        notificationCard.addView(notificationHeader, matchWrap());
        notificationHeader.addView(text("알림 권한", 15, TEXT, Typeface.BOLD), new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        ));
        notificationStatus = text("", 12, SUB, Typeface.BOLD);
        notificationStatus.setGravity(Gravity.CENTER);
        notificationStatus.setPadding(dp(10), dp(5), dp(10), dp(5));
        notificationHeader.addView(notificationStatus);

        TextView notificationNote = text(
            "재입고 알림을 받으려면 Android 알림 권한이 켜져 있어야 해요.",
            12,
            SUB,
            Typeface.NORMAL
        );
        notificationNote.setPadding(0, dp(10), 0, 0);
        notificationCard.addView(notificationNote);

        TextView notificationSettings = actionButton("알림 설정 열기", BLUE, BLUE_SOFT);
        LinearLayout.LayoutParams notificationButtonLp = matchWrap();
        notificationButtonLp.topMargin = dp(12);
        notificationCard.addView(notificationSettings, notificationButtonLp);
        notificationSettings.setOnClickListener(v -> {
            try {
                startActivity(NotificationAccess.settingsIntent(this));
            } catch (Exception ignored) {
                toast("알림 설정을 열지 못했어요.");
            }
        });

        LinearLayout batteryCard = surface(20, 18);
        LinearLayout.LayoutParams batteryLp = matchWrap();
        batteryLp.topMargin = dp(10);
        root.addView(batteryCard, batteryLp);

        LinearLayout batteryHeader = new LinearLayout(this);
        batteryHeader.setGravity(Gravity.CENTER_VERTICAL);
        batteryCard.addView(batteryHeader, matchWrap());
        batteryHeader.addView(text("백그라운드 실행", 15, TEXT, Typeface.BOLD), new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        ));
        batteryStatus = text("", 12, SUB, Typeface.BOLD);
        batteryStatus.setGravity(Gravity.CENTER);
        batteryStatus.setPadding(dp(10), dp(5), dp(10), dp(5));
        batteryHeader.addView(batteryStatus);

        TextView batteryNote = text(
            "장시간 감시가 중단되면 Android 앱 정보 > 배터리에서 '제한 없음'을 권장해요. 기기에 따라 메뉴 이름은 다를 수 있어요.",
            12,
            SUB,
            Typeface.NORMAL
        );
        batteryNote.setPadding(0, dp(10), 0, 0);
        batteryCard.addView(batteryNote);

        TextView batterySettings = actionButton("앱 배터리 설정 열기", BLUE, BLUE_SOFT);
        LinearLayout.LayoutParams batteryButtonLp = matchWrap();
        batteryButtonLp.topMargin = dp(12);
        batteryCard.addView(batterySettings, batteryButtonLp);
        batterySettings.setOnClickListener(v -> {
            try {
                startActivity(BatteryAccess.settingsIntent(this));
            } catch (Exception ignored) {
                toast("앱 설정을 열지 못했어요.");
            }
        });

        LinearLayout diagnosticCard = surface(20, 18);
        LinearLayout.LayoutParams diagnosticLp = matchWrap();
        diagnosticLp.topMargin = dp(10);
        root.addView(diagnosticCard, diagnosticLp);

        LinearLayout diagnosticHeader = new LinearLayout(this);
        diagnosticHeader.setGravity(Gravity.CENTER_VERTICAL);
        diagnosticCard.addView(diagnosticHeader, matchWrap());
        diagnosticHeader.addView(text("진단 로그", 15, TEXT, Typeface.BOLD), new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        ));
        diagnosticStatus = text("", 12, SUB, Typeface.BOLD);
        diagnosticStatus.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        diagnosticHeader.addView(diagnosticStatus);

        TextView diagnosticNote = text(
            "최근 7일 이벤트와 누적 조회 성공/실패를 기기에만 저장해요. 로그인 쿠키·응답 본문·개인정보는 기록하지 않아요.",
            12,
            SUB,
            Typeface.NORMAL
        );
        diagnosticNote.setPadding(0, dp(10), 0, 0);
        diagnosticCard.addView(diagnosticNote);

        LinearLayout diagnosticRow = new LinearLayout(this);
        diagnosticRow.setPadding(0, dp(12), 0, 0);
        diagnosticCard.addView(diagnosticRow, matchWrap());

        TextView viewDiagnostics = actionButton("로그 보기", BLUE, BLUE_SOFT);
        viewDiagnostics.setOnClickListener(v -> showDiagnostics());
        diagnosticRow.addView(viewDiagnostics, new LinearLayout.LayoutParams(0, dp(52), 1f));

        TextView clearDiagnostics = actionButton("로그 지우기", TEXT, FIELD);
        clearDiagnostics.setOnClickListener(v -> confirmClearDiagnostics());
        LinearLayout.LayoutParams clearDiagnosticsLp = new LinearLayout.LayoutParams(0, dp(52), 1f);
        clearDiagnosticsLp.leftMargin = dp(8);
        diagnosticRow.addView(clearDiagnostics, clearDiagnosticsLp);

                LinearLayout backupCard = surface(20, 18);
        LinearLayout.LayoutParams backupLp = matchWrap();
        backupLp.topMargin = dp(10);
        root.addView(backupCard, backupLp);
        backupCard.addView(text("데이터 백업", 15, TEXT, Typeface.BOLD));

        TextView backupNote = text(
            "등록한 상품, 선택 옵션, 알림 ON/OFF와 조회 주기를 JSON 파일로 보관할 수 있어요. 로그인 정보는 포함하지 않아요.",
            12,
            SUB,
            Typeface.NORMAL
        );
        backupNote.setPadding(0, dp(8), 0, 0);
        backupCard.addView(backupNote);

        LinearLayout backupRow = new LinearLayout(this);
        backupRow.setPadding(0, dp(12), 0, 0);
        backupCard.addView(backupRow, matchWrap());

        TextView export = actionButton("내보내기", BLUE, BLUE_SOFT);
        export.setOnClickListener(v -> exportBackup());
        backupRow.addView(export, new LinearLayout.LayoutParams(0, dp(52), 1f));

        TextView restore = actionButton("가져오기", TEXT, FIELD);
        restore.setOnClickListener(v -> importBackup());
        LinearLayout.LayoutParams restoreLp = new LinearLayout.LayoutParams(0, dp(52), 1f);
        restoreLp.leftMargin = dp(8);
        backupRow.addView(restore, restoreLp);

        TextView version = text("버전  " + versionName(), 13, SUB, Typeface.NORMAL);
        LinearLayout.LayoutParams versionLp = matchWrap();
        versionLp.topMargin = dp(22);
        root.addView(version, versionLp);

        setContentView(scroll);
        root.requestApplyInsets();
        refreshNotificationStatus();
        refreshBatteryStatus();
        refreshDiagnosticStatus();

        Motion.enter(header, 0L);
        Motion.enter(intervalCard, 35L);
        Motion.enter(notificationCard, 70L);
        Motion.enter(batteryCard, 105L);
        Motion.enter(diagnosticCard, 140L);
        Motion.enter(backupCard, 175L);
        Motion.enter(version, 205L);
    }

    private void exportBackup() {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        String date = new SimpleDateFormat("yyyyMMdd", Locale.KOREA).format(new Date());
        intent.putExtra(Intent.EXTRA_TITLE, "restock-backup-" + date + ".json");
        startActivityForResult(intent, REQUEST_EXPORT);
    }

    private void importBackup() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        startActivityForResult(intent, REQUEST_IMPORT);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        if (requestCode == REQUEST_EXPORT) {
            writeBackup(uri);
        } else if (requestCode == REQUEST_IMPORT) {
            readBackup(uri);
        }
    }

    private void writeBackup(Uri uri) {
        try (OutputStream out = getContentResolver().openOutputStream(uri, "w")) {
            if (out == null) throw new IllegalStateException();
            out.write(ProductStore.exportBackup(this).getBytes(StandardCharsets.UTF_8));
            out.flush();
            toast("백업 파일을 저장했어요.");
        } catch (Exception ignored) {
            toast("백업 파일을 저장하지 못했어요.");
        }
    }

    private void readBackup(Uri uri) {
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            if (input == null) throw new IllegalStateException();
            InputStreamReader reader = new InputStreamReader(input, StandardCharsets.UTF_8);
            StringBuilder content = new StringBuilder();
            char[] buffer = new char[4096];
            int read;
            while ((read = reader.read(buffer)) != -1) content.append(buffer, 0, read);
            String json = content.toString();

            new AlertDialog.Builder(this)
                .setTitle("백업을 가져올까요?")
                .setMessage("현재 상품 목록을 백업 파일의 내용으로 교체해요.")
                .setNegativeButton("취소", null)
                .setPositiveButton("가져오기", (dialog, which) -> restoreBackup(json))
                .show();
        } catch (Exception ignored) {
            toast("백업 파일을 읽지 못했어요.");
        }
    }

    private void restoreBackup(String json) {
        try {
            int count = ProductStore.importBackup(this, json);
            interval = MonitorPrefs.intervalSeconds(this);
            refreshChips();
            toast(count + "개 상품을 가져왔어요.");
        } catch (Exception ignored) {
            toast("Restock 백업 파일을 확인해주세요.");
        }
    }

    private void refreshNotificationStatus() {
        if (notificationStatus == null) return;
        boolean allowed = NotificationAccess.isAllowed(this);
        String next = allowed ? "허용됨" : "꺼짐";
        boolean changed = !next.contentEquals(notificationStatus.getText());
        notificationStatus.setText(next);
        notificationStatus.setTextColor(allowed ? GREEN : SUB);
        notificationStatus.setBackground(roundRect(allowed ? GREEN_SOFT : FIELD, 12));
        if (changed) Motion.valueChange(notificationStatus);
    }

    private void refreshBatteryStatus() {
        if (batteryStatus == null) return;
        boolean restricted = BatteryAccess.isBackgroundRestricted(this);
        String next = restricted ? "제한됨" : "허용됨";
        boolean changed = !next.contentEquals(batteryStatus.getText());
        batteryStatus.setText(next);
        batteryStatus.setTextColor(restricted ? SUB : GREEN);
        batteryStatus.setBackground(roundRect(restricted ? FIELD : GREEN_SOFT, 12));
        if (changed) Motion.valueChange(batteryStatus);
    }

    private void refreshDiagnosticStatus() {
        if (diagnosticStatus == null) return;
        diagnosticStatus.setText(DiagnosticLog.count(this) + "건");
    }

    private void showDiagnostics() {
        String message = DiagnosticLog.summary(this)
            + "\n\n최근 이벤트\n"
            + DiagnosticLog.formatRecent(this, 80);
        new AlertDialog.Builder(this)
            .setTitle("Restock 진단 로그")
            .setMessage(message)
            .setPositiveButton("닫기", null)
            .show();
    }

    private void confirmClearDiagnostics() {
        new AlertDialog.Builder(this)
            .setTitle("진단 로그를 지울까요?")
            .setMessage("누적 통계와 최근 이벤트 기록을 모두 초기화해요.")
            .setNegativeButton("취소", null)
            .setPositiveButton("지우기", (dialog, which) -> {
                DiagnosticLog.clear(this);
                refreshDiagnosticStatus();
                toast("진단 로그를 지웠어요.");
            })
            .show();
    }

    private String versionName() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName == null ? "" : info.versionName;
        } catch (Exception ignored) {
            return "";
        }
    }

    private void refreshChips() {
        if (chips == null) return;
        for (int i = 0; i < chips.length; i++) {
            boolean selected = VALUES[i] == interval;
            chips[i].setTextColor(selected ? BLUE : SUB);
            chips[i].setBackground(roundRect(selected ? BLUE_SOFT : FIELD, 12));
        }
    }

    private TextView actionButton(String label, int color, int background) {
        TextView view = text(label, 15, color, Typeface.BOLD);
        view.setGravity(Gravity.CENTER);
        view.setMinHeight(dp(54));
        view.setPadding(dp(16), dp(13), dp(16), dp(13));
        view.setBackground(roundRect(background, 14));
        Motion.press(view);
        return view;
    }

    private TextView text(String value, float size, int color, int style) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setTypeface(null, style);
        return view;
    }

    private LinearLayout surface(int radius, int padding) {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setPadding(dp(padding), dp(padding), dp(padding), dp(padding));
        view.setBackground(roundRect(WHITE, radius));
        return view;
    }

    private GradientDrawable roundRect(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radius));
        return drawable;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshNotificationStatus();
        refreshBatteryStatus();
        refreshDiagnosticStatus();
    }

    @Override
    public void finish() {
        super.finish();
        Motion.pop(this);
    }
}
