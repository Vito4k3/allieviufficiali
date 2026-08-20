-- ============================================================
--  RIPRISTINO CHIAVI — database Railway
--
--  PERCHE' SERVE
--  Il dump prodotto da phpMyAdmin (sql7833889.sql) contiene le tabelle
--  e i dati, ma NESSUNA chiave: zero PRIMARY KEY, zero UNIQUE KEY,
--  zero AUTO_INCREMENT. Su MySQL 5.5 (freesqldatabase) molti effetti
--  restavano nascosti; su MySQL 8 (Railway) no.
--
--  Conseguenza diretta gia' osservata:
--    Expression #2 of SELECT list is not in GROUP BY clause ...
--    incompatible with sql_mode=only_full_group_by
--  MySQL 8 accetta "GROUP BY l.id" con "SELECT l.*" solo se id e'
--  PRIMARY KEY (dipendenza funzionale). Senza chiave, rifiuta.
--
--  COME USARLO
--  1. Esegui prima la SEZIONE 0 e controlla che NON restituisca righe.
--  2. Se e' tutto vuoto, esegui le sezioni 1 -> 4.
--  3. Verifica con la SEZIONE 5.
--
--  Rieseguendolo una seconda volta MySQL segnalera' errori del tipo
--  "Duplicate key name" o "Multiple primary key defined": significa
--  soltanto che quella chiave e' gia' a posto, si possono ignorare.
-- ============================================================


-- ── SEZIONE 0 · CONTROLLO DUPLICATI (eseguire per prima) ────────
-- Ogni query DEVE restituire zero righe. Se una restituisce risultati,
-- ci sono dati duplicati da ripulire PRIMA di aggiungere i vincoli,
-- altrimenti la ALTER TABLE corrispondente fallira'.

SELECT 'users.id'          AS controllo, id      AS valore, COUNT(*) AS n FROM users                GROUP BY id       HAVING n > 1;
SELECT 'users.username'    AS controllo, username AS valore, COUNT(*) AS n FROM users               GROUP BY username HAVING n > 1;
SELECT 'users.email'       AS controllo, email   AS valore, COUNT(*) AS n FROM users                GROUP BY email    HAVING n > 1;
SELECT 'lists.id'          AS controllo, id      AS valore, COUNT(*) AS n FROM lists                GROUP BY id       HAVING n > 1;
SELECT 'list_signups.id'   AS controllo, id      AS valore, COUNT(*) AS n FROM list_signups         GROUP BY id       HAVING n > 1;
SELECT 'list_relatives.id' AS controllo, id      AS valore, COUNT(*) AS n FROM list_relatives       GROUP BY id       HAVING n > 1;
SELECT 'subjects.id'       AS controllo, id      AS valore, COUNT(*) AS n FROM subjects             GROUP BY id       HAVING n > 1;
SELECT 'grades.id'         AS controllo, id      AS valore, COUNT(*) AS n FROM grades               GROUP BY id       HAVING n > 1;
SELECT 'penalties.id'      AS controllo, id      AS valore, COUNT(*) AS n FROM penalties            GROUP BY id       HAVING n > 1;
SELECT 'notes.id'          AS controllo, id      AS valore, COUNT(*) AS n FROM notes                GROUP BY id       HAVING n > 1;
SELECT 'finance.id'        AS controllo, id      AS valore, COUNT(*) AS n FROM finance_transactions GROUP BY id       HAVING n > 1;
SELECT 'announcements.id'  AS controllo, id      AS valore, COUNT(*) AS n FROM announcements        GROUP BY id       HAVING n > 1;
SELECT 'schedule.id'       AS controllo, id      AS valore, COUNT(*) AS n FROM schedule_entries     GROUP BY id       HAVING n > 1;
SELECT 'calendar.id'       AS controllo, id      AS valore, COUNT(*) AS n FROM calendar_events      GROUP BY id       HAVING n > 1;
SELECT 'com_chat.id'       AS controllo, id      AS valore, COUNT(*) AS n FROM comunicazioni_chat   GROUP BY id       HAVING n > 1;
SELECT 'com_posts.id'      AS controllo, id      AS valore, COUNT(*) AS n FROM comunicazioni_posts  GROUP BY id       HAVING n > 1;
SELECT 'grade_settings'    AS controllo, user_id AS valore, COUNT(*) AS n FROM grade_settings       GROUP BY user_id  HAVING n > 1;

-- Doppie iscrizioni alla stessa lista (il vincolo mancante le ha rese possibili)
SELECT 'doppia iscrizione' AS controllo,
       CONCAT(list_id, ' / utente ', user_id) AS valore,
       COUNT(*) AS n
FROM list_signups
GROUP BY list_id, user_id
HAVING n > 1;

-- Celle di orario duplicate (l'upsert senza vincolo ha inserito invece di aggiornare)
SELECT 'cella orario' AS controllo,
       CONCAT(user_id, ' / giorno ', day_index, ' / ', hour) AS valore,
       COUNT(*) AS n
FROM schedule_entries
GROUP BY user_id, day_index, hour
HAVING n > 1;


-- ── SEZIONE 1 · PRIMARY KEY ─────────────────────────────────────
-- Risolve l'errore only_full_group_by e ripristina l'identita' delle righe.

ALTER TABLE `users`                ADD PRIMARY KEY (`id`);
ALTER TABLE `announcements`        ADD PRIMARY KEY (`id`);
ALTER TABLE `schedule_entries`     ADD PRIMARY KEY (`id`);
ALTER TABLE `lists`                ADD PRIMARY KEY (`id`);
ALTER TABLE `list_signups`         ADD PRIMARY KEY (`id`);
ALTER TABLE `list_relatives`       ADD PRIMARY KEY (`id`);
ALTER TABLE `subjects`             ADD PRIMARY KEY (`id`);
ALTER TABLE `grades`               ADD PRIMARY KEY (`id`);
ALTER TABLE `penalties`            ADD PRIMARY KEY (`id`);
ALTER TABLE `notes`                ADD PRIMARY KEY (`id`);
ALTER TABLE `finance_transactions` ADD PRIMARY KEY (`id`);
ALTER TABLE `calendar_events`      ADD PRIMARY KEY (`id`);
ALTER TABLE `comunicazioni_chat`   ADD PRIMARY KEY (`id`);
ALTER TABLE `comunicazioni_posts`  ADD PRIMARY KEY (`id`);
ALTER TABLE `grade_settings`       ADD PRIMARY KEY (`user_id`);


-- ── SEZIONE 2 · AUTO_INCREMENT ──────────────────────────────────
-- Queste tre tabelle hanno id numerico che il server NON valorizza:
--   INSERT INTO users (username,email,...)        -- niente id
--   INSERT INTO announcements (user_id,content)   -- niente id, poi usa insertId
--   INSERT INTO schedule_entries (user_id,day_index,...)
-- Senza AUTO_INCREMENT ogni nuova registrazione, ogni annuncio e ogni
-- cella di orario falliscono ("Field 'id' doesn't have a default value")
-- oppure finiscono tutti con id = 0.
-- Da eseguire DOPO la sezione 1: AUTO_INCREMENT richiede che la colonna sia chiave.

ALTER TABLE `users`            MODIFY `id` INT(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `announcements`    MODIFY `id` INT(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `schedule_entries` MODIFY `id` INT(11) NOT NULL AUTO_INCREMENT;


-- ── SEZIONE 3 · VINCOLI DI UNICITA' ─────────────────────────────
-- Il codice si affida all'errore ER_DUP_ENTRY per messaggi come
-- "Username o email gia' registrati" e "Gia' iscritto a questa lista".
-- Senza questi vincoli quei controlli non scattano mai.
-- Il vincolo su schedule_entries serve all'ON DUPLICATE KEY UPDATE:
-- senza, ogni salvataggio dell'orario duplica la riga invece di aggiornarla.

ALTER TABLE `users`            ADD UNIQUE KEY `uq_users_username` (`username`);
ALTER TABLE `users`            ADD UNIQUE KEY `uq_users_email`    (`email`);
ALTER TABLE `list_signups`     ADD UNIQUE KEY `unique_signup`     (`list_id`, `user_id`);
ALTER TABLE `schedule_entries` ADD UNIQUE KEY `uq_schedule_slot`  (`user_id`, `day_index`, `hour`);


-- ── SEZIONE 4 · INDICI DI RICERCA ───────────────────────────────
-- Senza indici ogni query fa una scansione completa della tabella.

ALTER TABLE `subjects`             ADD KEY `idx_subjects_user`  (`user_id`);
ALTER TABLE `grades`               ADD KEY `idx_grades_user`    (`user_id`),
                                   ADD KEY `idx_grades_subject` (`subject_id`);
ALTER TABLE `penalties`            ADD KEY `idx_penalties_user` (`user_id`);
ALTER TABLE `notes`                ADD KEY `idx_notes_user`     (`user_id`);
ALTER TABLE `finance_transactions` ADD KEY `idx_finance_user`   (`user_id`);
ALTER TABLE `announcements`        ADD KEY `idx_ann_user`       (`user_id`);
ALTER TABLE `list_signups`         ADD KEY `idx_signups_list`   (`list_id`);
ALTER TABLE `list_relatives`       ADD KEY `idx_relatives_list` (`list_id`, `user_id`);
ALTER TABLE `calendar_events`      ADD KEY `idx_cal_date`       (`event_date`);
ALTER TABLE `comunicazioni_chat`   ADD KEY `idx_chat_created`   (`created_at`);
ALTER TABLE `comunicazioni_posts`  ADD KEY `idx_posts_created`  (`created_at`);


-- ── SEZIONE 5 · VERIFICA ────────────────────────────────────────
-- Elenca tutte le chiavi presenti. tipo = UNICA significa PRIMARY o UNIQUE.

SELECT
  TABLE_NAME                                      AS tabella,
  INDEX_NAME                                      AS chiave,
  IF(NON_UNIQUE = 0, 'UNICA', 'indice')           AS tipo,
  GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS colonne
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE
ORDER BY TABLE_NAME, INDEX_NAME;

-- Conferma che AUTO_INCREMENT sia attivo sulle tre tabelle numeriche
SELECT TABLE_NAME AS tabella, COLUMN_NAME AS colonna, EXTRA AS extra
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('users', 'announcements', 'schedule_entries')
  AND COLUMN_NAME = 'id';
