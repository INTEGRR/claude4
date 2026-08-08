-- ===========================================================================
-- Labels in der Datenbank statt im Dateisystem
-- ===========================================================================
--
-- Bisher landete das PDF eines DHL-Labels als Datei unter STORAGE_DIR. Auf
-- einem Server mit eigener Platte (Docker) geht das; auf einer zustandslosen
-- Umgebung wie Vercel nicht — dort ist nur /tmp beschreibbar und nach dem
-- nächsten Aufruf wieder leer. Ein Label, das drei Minuten nach dem Drucken
-- verschwindet, ist schlimmer als keines.
--
-- Das PDF ist klein (~30–80 KB) und wird selten gelesen. Es gehört damit in
-- dieselbe Transaktion wie die Sendung selbst.

alter table shipments     add column if not exists label_pdf bytea;
alter table return_labels add column if not exists label_pdf bytea;

comment on column shipments.label_pdf is
  'DHL-Label als PDF. DHL hält es nur ~3 Tage vor, deshalb liegt es bei uns.';
comment on column return_labels.label_pdf is
  'Retourenlabel als PDF.';

-- label_path bleibt bestehen: bestehende Installationen mit Datei-Ablage
-- sollen ihre alten Labels weiter ausliefern können. Neue Labels schreiben
-- beide Spalten, gelesen wird bevorzugt aus der Datenbank.
comment on column shipments.label_path is
  'Alte Datei-Ablage (Docker mit gemountetem Verzeichnis). Nur noch lesend.';
