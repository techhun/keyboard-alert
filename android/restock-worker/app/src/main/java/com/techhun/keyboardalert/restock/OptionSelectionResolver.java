package com.techhun.keyboardalert.restock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class OptionSelectionResolver {
    private OptionSelectionResolver() {}

    static final class Resolution {
        final Map<String, Boolean> availability = new LinkedHashMap<>();
        final Map<String, Integer> quantities = new LinkedHashMap<>();
        final Map<String, String> labels = new LinkedHashMap<>();
        final Map<String, String> oldToNew = new LinkedHashMap<>();
        final JSONArray selectedIds = new JSONArray();
        final JSONObject selectedLabels = new JSONObject();
        int requestedCount;
        int migratedCount;

        boolean complete() {
            return requestedCount > 0 && availability.size() == requestedCount;
        }
    }

    static Resolution resolve(JSONArray configuredIds, JSONObject configuredLabels, JSONArray options) {
        Resolution result = new Resolution();
        if (configuredIds == null) return result;
        if (configuredLabels == null) configuredLabels = new JSONObject();
        if (options == null) options = new JSONArray();

        Map<String, JSONObject> byId = new LinkedHashMap<>();
        Map<String, List<JSONObject>> byLabel = new LinkedHashMap<>();
        for (int i = 0; i < options.length(); i++) {
            JSONObject option = options.optJSONObject(i);
            if (option == null) continue;
            String id = option.optString("id", "").trim();
            if (id.isEmpty() || byId.containsKey(id)) continue;
            byId.put(id, option);
            String normalized = normalizeLabel(optionLabel(option));
            if (!normalized.isEmpty()) {
                byLabel.computeIfAbsent(normalized, ignored -> new ArrayList<>()).add(option);
            }
        }

        for (int i = 0; i < configuredIds.length(); i++) {
            String oldId = configuredIds.optString(i, "").trim();
            if (oldId.isEmpty()) continue;
            result.requestedCount++;

            JSONObject matched = byId.get(oldId);
            if (matched == null) {
                String oldLabel = configuredLabels.optString(oldId, "");
                List<JSONObject> sameLabel = byLabel.get(normalizeLabel(oldLabel));
                if (sameLabel != null && sameLabel.size() == 1) matched = sameLabel.get(0);
            }
            if (matched == null) continue;

            String newId = matched.optString("id", "").trim();
            if (newId.isEmpty() || result.availability.containsKey(newId)) continue;
            String label = optionLabel(matched);
            result.availability.put(newId, matched.optBoolean("available", false));
            if (!matched.isNull("stockQuantity")) {
                double quantity = matched.optDouble("stockQuantity", Double.NaN);
                if (Double.isFinite(quantity) && quantity >= 0 && quantity <= Integer.MAX_VALUE
                    && quantity == Math.floor(quantity)) {
                    result.quantities.put(newId, (int) quantity);
                }
            }
            result.labels.put(newId, label);
            result.oldToNew.put(oldId, newId);
            result.selectedIds.put(newId);
            try { result.selectedLabels.put(newId, label); } catch (Exception ignored) {}
            if (!oldId.equals(newId)) result.migratedCount++;
        }
        return result;
    }

    static String optionLabel(JSONObject option) {
        if (option == null) return "옵션";
        StringBuilder label = new StringBuilder();
        for (String key : new String[]{"optionName1", "optionName2", "optionName3"}) {
            String value = option.optString(key, "").trim();
            if (value.isEmpty() || "null".equalsIgnoreCase(value)) continue;
            if (label.length() > 0) label.append(" / ");
            label.append(value);
        }
        return label.length() > 0 ? label.toString() : option.optString("id", "옵션");
    }

    static String normalizeLabel(String value) {
        if (value == null) return "";
        return Normalizer.normalize(value, Normalizer.Form.NFKC)
            .toLowerCase(Locale.ROOT)
            .replaceAll("[\\s/|>,·]+", "")
            .trim();
    }
}
