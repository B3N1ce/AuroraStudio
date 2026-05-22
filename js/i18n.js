// js/i18n.js

const translations = {
    de: {
        title: "Aurora Studio",
        subheadline: "Licht-Animationen entwerfen und simulieren – für Home Assistant.",
        validate_yaml: "✔ YAML Prüfen",
        start: "▶ Starten",
        pause: "⏸ Pause",
        stop: "⏹ Stopp",
        reset: "↺ Reset",
        resume: "▶ Weiter",
        yaml_script: "YAML Skript",
        copy_code: "Code kopieren",
        save_yaml: "Als .yaml speichern",
        simulation: "Simulation",
        toggle_labels: "Labels ein/ausblenden",
        toggle_entities: "Lampen-Körper ein/ausblenden",
        light_influence: "Licht-Einfluss auf Hintergrund",
        ambient_light: "Umgebungslicht (Ambient)",
        blend_mode_title: "Mischmodus für Hintergrund-Beleuchtung",
        blend_realistic: "Realistisch (Multi + Glow)",
        blend_multiply: "Klarer Schatten (Multiply)",
        blend_overlay: "Kontrastreich (Overlay)",
        blend_dodge: "Neon-Effekt (Color Dodge)",
        inspector: "Inspector",
        color_picker: "Color Picker",
        insert_editor: "Bei Textposition einfügen",
        save_color: "Aktuelle Farbe speichern",
        env_groups: "Umgebung & Gruppen",
        global_vars: "Globale Variablen",
        tab_editor: "Editor",
        tab_preview: "Vorschau",
        tab_tools: "Tools",
        system_log: "System Log",
        clear_all: "Alle löschen",
        no_messages: "Keine Nachrichten",
        enter_code: "Bitte Code eingeben.",
        yaml_correct: "YAML Syntax ist korrekt! ✅",
        yaml_error: "YAML Fehler: ",
        code_copied: "Code kopiert!",
        script_error: "Skript Fehler:\n",
        off: "Aus",
        no_entities: "Keine Entitäten im Skript gefunden.",
        toggle_vis: "Sichtbarkeit umschalten",
        mark_group: "Als Gruppe markieren",
        remove_group: "Aus Gruppe entfernen",
        ungroup: "Gruppe auflösen",
        no_vars: "Keine Variablen definiert.",
        gamma_linear: "Linear (Raw)",
        gamma_22: "Gamma 2.2",
        gamma_28: "Gamma 2.8",
        gamma_cie: "CIE L* (Wahrnehmung)",
        fav_tooltip: "Klicken zum Anwenden, Doppelklick zum Löschen",
        exposure: "Belichtung (Exposure)",
        node_editor: "Nodes",
        new_script: "Neues Skript",
        confirm_new_script: "Möchtest du ein neues Skript starten? Deine aktuellen Änderungen werden überschrieben.",
        new_from_scratch: "From Scratch",
        new_from_scratch_desc: "Leeres Skript starten",
        new_template: "Beginner Template",
        new_template_desc: "Mit Beispiel-Code starten",
        cancel: "Abbrechen",
        choose_bg: "Hintergrund wählen",
        bg_living_room: "Wohnzimmer",
        bg_living_room_desc: "Moderner Loft-Style",
        bg_bedroom: "Schlafzimmer",
        bg_bedroom_desc: "Gemütliches Ambiente",
        bg_office: "Home Office",
        bg_office_desc: "Arbeitszimmer bei Nacht",
        bg_lightstudio: "Light Studio",
        bg_lightstudio_desc: "Neutral dunkler Testraum",
        bg_upload: "Eigenes Foto...",
        bg_upload_desc: "Bild von deinem Raum laden",
        bg_reset: "Einfarbig (Zurücksetzen)",
        bg_reset_desc: "Hintergrundbild entfernen",
        new_script_created: "Neues Skript erstellt",
        no_vars_found: "Keine Variablen definiert",
        click_to_insert: "Klicken zum Einfügen",
        copied_to_clipboard: "In Zwischenablage kopiert",
        color_space: "Farbraum",
        blend_mode: "Mischmodus"
    },
    en: {
        title: "Aurora Studio",
        subheadline: "Design and simulate light animations – made for Home Assistant.",
        validate_yaml: "✔ Validate YAML",
        start: "▶ Start",
        pause: "⏸ Pause",
        stop: "⏹ Stop",
        reset: "↺ Reset",
        resume: "▶ Resume",
        yaml_script: "YAML Script",
        copy_code: "Copy code",
        save_yaml: "Save as .yaml",
        simulation: "Simulation",
        toggle_labels: "Toggle labels",
        toggle_entities: "Toggle entity fixtures",
        light_influence: "Light influence on background",
        ambient_light: "Ambient light level",
        blend_mode_title: "Blend mode for background lighting",
        blend_realistic: "Realistic (Multi + Glow)",
        blend_multiply: "Crisp Shadow (Multiply)",
        blend_overlay: "High Contrast (Overlay)",
        blend_dodge: "Neon Effect (Color Dodge)",
        inspector: "Inspector",
        color_picker: "Color Picker",
        insert_editor: "Insert at text position",
        save_color: "Save current color",
        env_groups: "Environment & Groups",
        global_vars: "Global Variables",
        tab_editor: "Editor",
        tab_preview: "Preview",
        tab_tools: "Tools",
        system_log: "System Log",
        clear_all: "Clear all",
        no_messages: "No messages",
        enter_code: "Please enter code.",
        yaml_correct: "YAML syntax is correct! ✅",
        yaml_error: "YAML error: ",
        code_copied: "Code copied!",
        script_error: "Script error:\n",
        off: "Off",
        no_entities: "No entities found in script.",
        toggle_vis: "Toggle visibility",
        mark_group: "Mark as group",
        remove_group: "Remove from group",
        ungroup: "Ungroup",
        no_vars: "No variables defined.",
        gamma_linear: "Linear (Raw)",
        gamma_22: "Gamma 2.2",
        gamma_28: "Gamma 2.8",
        gamma_cie: "CIE L* (Perceptual)",
        fav_tooltip: "Click to apply, double-click to delete",
        exposure: "Exposure",
        node_editor: "Nodes",
        new_script: "New Script",
        confirm_new_script: "Do you want to start a new script? Your current changes will be overwritten.",
        new_from_scratch: "From Scratch",
        new_from_scratch_desc: "Start with a blank script",
        new_template: "Beginner Template",
        new_template_desc: "Start with example code",
        cancel: "Cancel",
        choose_bg: "Choose Background",
        bg_living_room: "Living Room",
        bg_living_room_desc: "Modern loft style",
        bg_bedroom: "Bedroom",
        bg_bedroom_desc: "Cozy atmosphere",
        bg_office: "Home Office",
        bg_office_desc: "Study at night",
        bg_lightstudio: "Light Studio",
        bg_lightstudio_desc: "Neutral dark test room",
        bg_upload: "Custom photo...",
        bg_upload_desc: "Load an image of your room",
        bg_reset: "Solid Color (Reset)",
        bg_reset_desc: "Remove background image",
        new_script_created: "New script created",
        no_vars_found: "No variables defined",
        click_to_insert: "Click to insert",
        copied_to_clipboard: "Copied to clipboard",
        color_space: "Color Space",
        blend_mode: "Blend Mode"
    }
};

let currentLang = localStorage.getItem('ha_simulator_lang') || 'de';

export function getLang() {
    return currentLang;
}

export function setLang(lang) {
    currentLang = lang;
    localStorage.setItem('ha_simulator_lang', lang);
    applyTranslations();
}

export function t(key) {
    return translations[currentLang][key] || key;
}

export function applyTranslations() {
    // 1. Static Elements in HTML (using data-i18n attribute)
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (el.tagName === 'INPUT' && el.type === 'button') {
            el.value = t(key);
        } else {
            el.innerText = t(key);
        }
    });

    // 2. Titles/Tooltips
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = t(el.dataset.i18nTitle);
    });

    // 3. Special cases (placeholders, etc. if needed)

    // Update Language Button Label
    const langLabel = document.getElementById('lang-label');
    if (langLabel) langLabel.innerText = currentLang.toUpperCase();

    // Trigger update in other modules if needed via event
    document.dispatchEvent(new CustomEvent('languageChanged', { detail: currentLang }));
}
