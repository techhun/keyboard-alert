package com.techhun.keyboardalert.restock;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.text.Spannable;
import android.text.SpannableStringBuilder;
import android.text.style.ForegroundColorSpan;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class SettingsActivity extends Activity {
    private static final int[] VALUES = {10, 15, 30, 60};
    private static final String[] LABELS = {"10초", "15초", "30초", "60초"};
    private static final int REQUEST_EXPORT = 9201;
    private static final int REQUEST_IMPORT = 9202;

    private int BG;
    private int WHITE;
    private int TEXT;
    private int SUB;
    private int BLUE;
    private int FIELD;
    private int GREEN;
    private int GREEN_SOFT;
    private int RED;
    private int WARN;
    private int WARN_SOFT;
    private int LINE;

    private TextView[] chips;
    private View statusDot;
    private TextView statusTitle;
    private TextView statusCount;
    private TextView statusDetail;
    private TextView permissionChip;
    private TextView batteryChip;
    private TextView lowStockValue;
    private TextView diagnosticSummary;
    private int interval;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        loadTokens();
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
            int side = Ui.dim(this, R.dimen.restock_screen_padding);
            view.setPadding(side, top + dp(10), side, bottom + dp(24));
            return insets;
        });
        scroll.addView(root, new ScrollView.LayoutParams(
            ScrollView.LayoutParams.MATCH_PARENT,
            ScrollView.LayoutParams.WRAP_CONTENT
        ));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(header, Ui.matchWrap());

        ImageView back = new ImageView(this);
        back.setImageResource(R.drawable.ic_chevron_left);
        back.setColorFilter(TEXT);
        back.setContentDescription("뒤로");
        back.setScaleType(ImageView.ScaleType.FIT_CENTER);
        back.setPadding(dp(12), dp(12), dp(12), dp(12));
        back.setOnClickListener(v -> finish());
        Motion.press(back);
        LinearLayout.LayoutParams backLp = Ui.fixed(
            Ui.dim(this, R.dimen.restock_touch_min),
            Ui.dim(this, R.dimen.restock_touch_min)
        );
        backLp.leftMargin = -dp(12);
        header.addView(back, backLp);

        header.addView(Ui.text(this, "설정", R.dimen.restock_text_screen_title, TEXT, Typeface.BOLD));

        LinearLayout statusCard = buildStatusCard();
        LinearLayout.LayoutParams statusLp = Ui.matchWrap();
        statusLp.topMargin = dp(18);
        root.addView(statusCard, statusLp);

        LinearLayout intervalCard = buildIntervalCard();
        LinearLayout.LayoutParams intervalLp = Ui.matchWrap();
        intervalLp.topMargin = dp(10);
        root.addView(intervalCard, intervalLp);

        LinearLayout lowStockCard = buildLowStockCard();
        LinearLayout.LayoutParams lowStockLp = Ui.matchWrap();
        lowStockLp.topMargin = dp(10);
        root.addView(lowStockCard, lowStockLp);

        LinearLayout systemCard = buildSystemCard();
        LinearLayout.LayoutParams systemLp = Ui.matchWrap();
        systemLp.topMargin = dp(10);
        root.addView(systemCard, systemLp);

        LinearLayout diagnosticCard = buildDiagnosticCard();
        LinearLayout.LayoutParams diagnosticLp = Ui.matchWrap();
        diagnosticLp.topMargin = dp(10);
        root.addView(diagnosticCard, diagnosticLp);

        TextView version = Ui.text(
            this,
            "Restock " + versionName() + " (" + versionCode() + ")",
            R.dimen.restock_text_caption,
            SUB,
            Typeface.NORMAL
        );
        version.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams versionLp = Ui.matchWrap();
        versionLp.topMargin = dp(18);
        root.addView(version, versionLp);

        setContentView(scroll);
        root.requestApplyInsets();
        refreshStatusCard();
        refreshDiagnosticStatus();

        Motion.enter(header, 0L);
        Motion.enter(statusCard, 30L);
        Motion.enter(intervalCard, 60L);
        Motion.enter(lowStockCard, 85L);
        Motion.enter(systemCard, 110L);
        Motion.enter(diagnosticCard, 135L);
        Motion.enter(version, 160L);
    }

    private void loadTokens() {
        BG = Ui.color(this, R.color.restock_bg);
        WHITE = Ui.color(this, R.color.restock_surface);
        TEXT = Ui.color(this, R.color.restock_ink);
        SUB = Ui.color(this, R.color.restock_ink_2);
        BLUE = Ui.color(this, R.color.restock_accent);
        FIELD = Ui.color(this, R.color.restock_field);
        GREEN = Ui.color(this, R.color.restock_ok);
        GREEN_SOFT = Ui.color(this, R.color.restock_ok_soft);
        RED = Ui.color(this, R.color.restock_danger);
        WARN = Ui.color(this, R.color.restock_warn);
        WARN_SOFT = Ui.color(this, R.color.restock_warn_soft);
        LINE = Ui.color(this, R.color.restock_line);
    }

    /** 감시 상태: 동작 여부 · 감시 개수 · 마지막 확인 · 권한/배터리 칩을 한 카드에 모은다. */
    private LinearLayout buildStatusCard() {
        LinearLayout card = Ui.surface(this);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));

        LinearLayout topRow = new LinearLayout(this);
        topRow.setGravity(Gravity.CENTER_VERTICAL);
        card.addView(topRow, Ui.matchWrap());

        statusDot = Ui.dot(this, GREEN, 8);
        LinearLayout.LayoutParams dotLp = Ui.fixed(dp(8), dp(8));
        dotLp.rightMargin = dp(8);
        topRow.addView(statusDot, dotLp);

        statusTitle = Ui.text(this, "", R.dimen.restock_text_card_title, TEXT, Typeface.BOLD);
        topRow.addView(statusTitle, new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        ));

        statusCount = Ui.text(this, "", R.dimen.restock_text_label, SUB, Typeface.NORMAL);
        topRow.addView(statusCount);

        statusDetail = Ui.text(this, "", R.dimen.restock_text_label, SUB, Typeface.NORMAL);
        statusDetail.setSingleLine(true);
        LinearLayout.LayoutParams detailLp = Ui.matchWrap();
        detailLp.topMargin = dp(6);
        card.addView(statusDetail, detailLp);

        LinearLayout chipRow = new LinearLayout(this);
        chipRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams chipRowLp = Ui.matchWrap();
        chipRowLp.topMargin = dp(12);
        card.addView(chipRow, chipRowLp);

        permissionChip = buildPill("");
        chipRow.addView(permissionChip);
        batteryChip = buildPill("");
        LinearLayout.LayoutParams batteryLp = Ui.wrapWrap();
        batteryLp.leftMargin = dp(8);
        chipRow.addView(batteryChip, batteryLp);

        return card;
    }

    private TextView buildPill(String label) {
        TextView pill = Ui.text(this, label, R.dimen.restock_text_caption, GREEN, Typeface.BOLD);
        pill.setGravity(Gravity.CENTER);
        pill.setPadding(dp(10), 0, dp(12), 0);
        pill.setLayoutParams(new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            Ui.dim(this, R.dimen.restock_pill_height)
        ));
        return pill;
    }

    private LinearLayout buildIntervalCard() {
        LinearLayout card = Ui.surface(this);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));
        card.addView(
            Ui.text(this, "조회 주기", R.dimen.restock_text_body, TEXT, Typeface.BOLD),
            Ui.matchWrap()
        );

        LinearLayout row = new LinearLayout(this);
        LinearLayout.LayoutParams rowLp = Ui.matchWrap();
        rowLp.topMargin = dp(12);
        card.addView(row, rowLp);

        chips = new TextView[VALUES.length];
        int chipHeight = Ui.dim(this, R.dimen.restock_chip_height);
        int touch = Ui.dim(this, R.dimen.restock_touch_min);
        for (int i = 0; i < VALUES.length; i++) {
            final int value = VALUES[i];
            FrameLayout box = new FrameLayout(this);
            box.setMinimumHeight(touch);

            TextView chip = Ui.text(this, LABELS[i], R.dimen.restock_text_body, SUB, Typeface.BOLD);
            chip.setGravity(Gravity.CENTER);
            box.addView(chip, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                chipHeight,
                Gravity.CENTER
            ));
            box.setOnClickListener(v -> {
                interval = value;
                MonitorPrefs.prefs(this).edit().putInt(MonitorPrefs.KEY_INTERVAL, value).apply();
                refreshChips();
                refreshStatusCard();
                Motion.selection(chip);
            });
            Motion.press(chip);
            chips[i] = chip;

            LinearLayout.LayoutParams boxLp = Ui.row(1f, touch);
            if (i > 0) boxLp.leftMargin = dp(8);
            row.addView(box, boxLp);
        }
        refreshChips();

        TextView note = Ui.text(
            this,
            "알림 상품을 나눠서 확인하며, 요청 보호를 위해 실제 간격은 더 길어질 수 있어요.",
            R.dimen.restock_text_label,
            SUB,
            Typeface.NORMAL
        );
        note.setLineSpacing(0f, 1.25f);
        LinearLayout.LayoutParams noteLp = Ui.matchWrap();
        noteLp.topMargin = dp(12);
        card.addView(note, noteLp);
        return card;
    }

    private LinearLayout buildLowStockCard() {
        LinearLayout card = Ui.surface(this);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));
        card.addView(
            Ui.text(this, "재고 부족 알림", R.dimen.restock_text_body, TEXT, Typeface.BOLD),
            Ui.matchWrap()
        );

        TextView note = Ui.text(
            this,
            "SmartStore 선택 옵션 수량이 기준 이하로 줄면 알려줘요.\nSWAGKEY는 잔여 수량을 제공하지 않아요.",
            R.dimen.restock_text_label,
            SUB,
            Typeface.NORMAL
        );
        note.setLineSpacing(0f, 1.3f);
        LinearLayout.LayoutParams noteLp = Ui.matchWrap();
        noteLp.topMargin = dp(6);
        card.addView(note, noteLp);

        LinearLayout.LayoutParams dividerLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            Math.max(1, dp(1))
        );
        dividerLp.topMargin = dp(12);
        card.addView(Ui.hairline(this, LINE), dividerLp);

        LinearLayout valueRow = new LinearLayout(this);
        valueRow.setGravity(Gravity.CENTER_VERTICAL);
        valueRow.setMinimumHeight(Ui.dim(this, R.dimen.restock_touch_min));
        valueRow.setOnClickListener(v -> editLowStockThreshold());
        Motion.press(valueRow);
        card.addView(valueRow, Ui.matchWrap());

        valueRow.addView(
            Ui.text(this, "기준 수량", R.dimen.restock_text_body, TEXT, Typeface.NORMAL),
            new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        );

        lowStockValue = Ui.text(
            this,
            MonitorPrefs.lowStockThreshold(this) + "개 이하",
            R.dimen.restock_text_body,
            BLUE,
            Typeface.BOLD
        );
        valueRow.addView(lowStockValue);
        valueRow.addView(chevron());
        return card;
    }

    private LinearLayout buildSystemCard() {
        LinearLayout card = Ui.surface(this);
        card.setPadding(dp(16), dp(14), dp(16), dp(6));

        TextView label = Ui.text(this, "시스템 설정", R.dimen.restock_text_label, SUB, Typeface.BOLD);
        LinearLayout.LayoutParams labelLp = Ui.matchWrap();
        labelLp.bottomMargin = dp(6);
        card.addView(label, labelLp);

        addSystemRow(card, "알림 설정 열기", v -> {
            try {
                startActivity(NotificationAccess.settingsIntent(this));
            } catch (Exception ignored) {
                toast("알림 설정을 열지 못했어요.");
            }
        }, false);
        addSystemRow(card, "앱 배터리 설정 열기", v -> {
            try {
                startActivity(BatteryAccess.settingsIntent(this));
            } catch (Exception ignored) {
                toast("앱 설정을 열지 못했어요.");
            }
        }, true);
        addSystemRow(card, "설정 백업 · 복원", v -> showBackupDialog(), true);
        return card;
    }

    private void addSystemRow(LinearLayout card, String label, View.OnClickListener listener, boolean divider) {
        if (divider) {
            card.addView(
                Ui.hairline(this, LINE),
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, Math.max(1, dp(1)))
            );
        }
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(Ui.dim(this, R.dimen.restock_list_row_height));
        row.setOnClickListener(listener);
        Motion.press(row);
        card.addView(row, Ui.matchWrap());

        TextView text = Ui.text(this, label, R.dimen.restock_text_body, TEXT, Typeface.NORMAL);
        row.addView(text, new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        ));
        row.addView(chevron());
    }

    private LinearLayout buildDiagnosticCard() {
        LinearLayout card = Ui.surface(this);
        card.setPadding(dp(16), dp(14), dp(16), dp(14));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(Ui.dim(this, R.dimen.restock_touch_min));
        row.setOnClickListener(v -> showDiagnostics());
        Motion.press(row);
        card.addView(row, Ui.matchWrap());

        row.addView(
            Ui.text(this, "진단 로그", R.dimen.restock_text_body, TEXT, Typeface.BOLD),
            new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        );

        diagnosticSummary = Ui.text(this, "", R.dimen.restock_text_label, SUB, Typeface.NORMAL);
        row.addView(diagnosticSummary);
        row.addView(chevron());
        return card;
    }

    private ImageView chevron() {
        ImageView view = new ImageView(this);
        view.setImageResource(R.drawable.ic_chevron_right);
        view.setColorFilter(SUB);
        view.setScaleType(ImageView.ScaleType.FIT_CENTER);
        LinearLayout.LayoutParams lp = Ui.fixed(dp(20), dp(20));
        lp.leftMargin = dp(6);
        view.setLayoutParams(lp);
        return view;
    }

    private void refreshStatusCard() {
        if (statusTitle == null) return;
        JSONArray products = ProductStore.list(this);
        int enabled = ProductStatus.enabledCount(products);
        int failures = ProductStatus.failureCount(products);
        long lastCheck = ProductStatus.latestCheck(products);
        boolean allowed = NotificationAccess.isAllowed(this);
        boolean restricted = BatteryAccess.isBackgroundRestricted(this);
        boolean running = MonitorPrefs.prefs(this).getBoolean(MonitorPrefs.KEY_RUNNING, false);

        String title;
        int titleColor;
        int dotColor;
        if (enabled <= 0) {
            title = "감시 중지됨";
            titleColor = SUB;
            dotColor = Ui.color(this, R.color.restock_track_off);
        } else if (!allowed) {
            title = "알림 권한 필요";
            titleColor = RED;
            dotColor = RED;
        } else if (!running) {
            title = "감시 대기 중";
            titleColor = WARN;
            dotColor = WARN;
        } else {
            title = "정상 동작 중";
            titleColor = TEXT;
            dotColor = GREEN;
        }
        statusTitle.setText(title);
        statusTitle.setTextColor(titleColor);
        statusDot.setBackground(Ui.roundRect(this, dotColor, 4));
        statusCount.setText("감시 중 " + enabled + "개");

        SpannableStringBuilder detail = new SpannableStringBuilder();
        detail.append("마지막 확인 ")
            .append(lastCheck > 0L
                ? ProductStatus.relativeTime(lastCheck, System.currentTimeMillis())
                : "기록 없음")
            .append(" · 조회 주기 ")
            .append(String.valueOf(MonitorPrefs.intervalSeconds(this)))
            .append("초");
        if (failures > 0) {
            detail.append(" · ");
            int start = detail.length();
            detail.append("실패 ").append(String.valueOf(failures)).append("건");
            detail.setSpan(
                new ForegroundColorSpan(RED),
                start,
                detail.length(),
                Spannable.SPAN_EXCLUSIVE_EXCLUSIVE
            );
        }
        statusDetail.setText(detail);

        bindPill(permissionChip, allowed ? "알림 권한 허용됨" : "알림 권한 꺼짐", allowed);
        bindPill(batteryChip, restricted ? "배터리 제한 있음" : "배터리 제한 없음", !restricted);
    }

    private void bindPill(TextView pill, String label, boolean good) {
        if (pill == null) return;
        pill.setText(label);
        pill.setTextColor(good ? GREEN : WARN);
        pill.setBackground(Ui.roundRect(this, good ? GREEN_SOFT : WARN_SOFT, 12));
    }

    private void refreshDiagnosticStatus() {
        if (diagnosticSummary == null) return;
        diagnosticSummary.setText("최근 이벤트 " + DiagnosticLog.count(this) + "건");
    }

    private void editLowStockThreshold() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_NUMBER);
        input.setSingleLine(true);
        input.setText(String.valueOf(MonitorPrefs.lowStockThreshold(this)));
        input.selectAll();
        int padding = dp(24);
        LinearLayout container = new LinearLayout(this);
        container.setPadding(padding, dp(8), padding, 0);
        container.addView(input, Ui.matchWrap());
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle("재고 부족 기준 수량")
            .setMessage("1~999개 중에서 설정해주세요.")
            .setView(container)
            .setNegativeButton("취소", null)
            .setPositiveButton("저장", null)
            .create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            try {
                int value = Integer.parseInt(input.getText().toString().trim());
                if (value < 1 || value > 999) throw new NumberFormatException();
                int previous = MonitorPrefs.lowStockThreshold(this);
                MonitorPrefs.prefs(this).edit().putInt(MonitorPrefs.KEY_LOW_STOCK_THRESHOLD, value).apply();
                if (value != previous) ProductStore.resetLowStockState(this);
                if (lowStockValue != null) lowStockValue.setText(value + "개 이하");
                dialog.dismiss();
            } catch (NumberFormatException error) {
                input.setError("1~999 사이 숫자를 입력해주세요.");
            }
        }));
        dialog.show();
    }

    private void showBackupDialog() {
        new AlertDialog.Builder(this)
            .setTitle("설정 백업 · 복원")
            .setMessage("등록한 상품, 선택 옵션, 알림 ON/OFF, 조회 주기, 재고 부족 기준을 JSON 파일로 보관해요. 로그인 정보는 포함하지 않아요.")
            .setItems(new String[]{"백업 파일로 내보내기", "백업 파일에서 가져오기"}, (dialog, which) -> {
                if (which == 0) exportBackup();
                else importBackup();
            })
            .show();
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
            if (lowStockValue != null) {
                lowStockValue.setText(MonitorPrefs.lowStockThreshold(this) + "개 이하");
            }
            refreshStatusCard();
            toast(count + "개 상품을 가져왔어요.");
        } catch (Exception ignored) {
            toast("Restock 백업 파일을 확인해주세요.");
        }
    }

    private void showDiagnostics() {
        String message = DiagnosticLog.summary(this)
            + "\n\n최근 이벤트\n"
            + DiagnosticLog.formatRecent(this, 80);
        new AlertDialog.Builder(this)
            .setTitle("Restock 진단 로그")
            .setMessage(message)
            .setNeutralButton("로그 복사", (dialog, which) -> copyDiagnostics())
            .setNegativeButton("로그 지우기", (dialog, which) -> confirmClearDiagnostics())
            .setPositiveButton("닫기", null)
            .show();
    }

    private void copyDiagnostics() {
        String content = DiagnosticLog.exportText(this, versionName());
        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
        if (clipboard == null) {
            toast("클립보드를 사용할 수 없어요.");
            return;
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("Restock 진단 로그", content));
        toast("진단 로그 전체를 복사했어요.");
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

    private long versionCode() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= 28) return info.getLongVersionCode();
            return info.versionCode;
        } catch (Exception ignored) {
            return 0L;
        }
    }

    private void refreshChips() {
        if (chips == null) return;
        for (int i = 0; i < chips.length; i++) {
            boolean selected = VALUES[i] == interval;
            chips[i].setTextColor(selected ? WHITE : SUB);
            chips[i].setBackground(Ui.roundRect(this, selected ? BLUE : FIELD, 10));
        }
    }

    private int dp(int value) {
        return Ui.dp(this, value);
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshStatusCard();
        refreshDiagnosticStatus();
        refreshChips();
    }

    @Override
    public void finish() {
        super.finish();
        Motion.pop(this);
    }
}
