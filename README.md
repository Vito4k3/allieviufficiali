# Portale Allievi Ufficiali

**Un portale web progettato per riunire in un unico ambiente gli strumenti digitali utili alla vita quotidiana degli Allievi Ufficiali.**

[Apri il sito](https://sito-allievi-accademia-militare.onrender.com) · [Esplora il codice](https://github.com/Vito4k3/allieviufficiali)

> **Progetto indipendente e non ufficiale.** È un software realizzato autonomamente per gli Allievi Ufficiali dell’Accademia Militare di Modena. Non è un prodotto dell’Accademia, non è approvato né gestito dall’Accademia o dal Ministero della Difesa e non sostituisce i canali o le procedure istituzionali.

## Il progetto

Il portale nasce da un’esigenza concreta: rendere più semplice l’accesso a informazioni e attività che altrimenti richiederebbero strumenti separati. Ho progettato e sviluppato una web app responsive che raccoglie comunicazioni, organizzazione delle liste, calendario, registro didattico e strumenti personali in un’interfaccia unica.

Il progetto unisce sviluppo full stack e attenzione ai flussi d’uso: gli accessi sono gestiti per account, le funzioni possono essere abilitate in base ai permessi e alcune attività ripetitive — come preparare il modulo Excel giornaliero delle libere uscite — vengono automatizzate.

## Funzionalità

- **Bacheca e comunicazioni:** annunci, chat e pubblicazione di comunicati con allegati.
- **Liste:** iscrizioni a liste di reparto, libere uscite, messa, parlatorio e liste personalizzate; esportazione Excel delle libere uscite con gli iscritti riuniti per giornata.
- **Registro:** voti universitari, militari e di ginnastica, medie e graduatoria, punizioni, orario e note, organizzati per anno di corso.
- **Calendario:** consultazione e gestione degli eventi.
- **Finanze personali:** registrazione e riepilogo di entrate, spese, investimenti e ricavi, con grafici e storico.
- **Amministrazione:** gestione degli account, dei ruoli e dei permessi di accesso alle sezioni.
- **Esperienza mobile:** interfaccia responsive e installabile come Progressive Web App; le risorse essenziali dell’interfaccia possono essere disponibili anche offline.

Le aree riservate richiedono un account; alcune funzioni dipendono dai permessi assegnati dall’amministratore. Il sito online può quindi richiedere un accesso abilitato.

## Tecnologie

- **Frontend:** HTML, CSS e JavaScript senza framework, con interfaccia a pagina singola.
- **Backend:** Node.js ed Express, con API REST.
- **Database:** MySQL, tramite `mysql2`.
- **Autenticazione:** password protette con `bcrypt`, token JWT firmati e controlli di accesso lato server.
- **Documenti:** generazione di file Excel a partire da modelli `.xlsx`, mantenendone l’impaginazione.
- **PWA:** Web App Manifest e Service Worker per installazione e cache delle risorse dell’interfaccia.

## Competenze applicate

Il progetto attraversa l’intero ciclo di sviluppo di un prodotto web: raccolta di un’esigenza d’uso, progettazione dei flussi, realizzazione dell’interfaccia, sviluppo delle API, integrazione con un database relazionale, gestione di ruoli e permessi, elaborazione di documenti Excel e pubblicazione di un’applicazione web installabile. Le funzionalità sono state costruite attorno a casi d’uso reali e rifinite nel tempo sulla base dell’utilizzo.

## Struttura del repository

```text
.
├── server.js                  # API, autenticazione e avvio del server
├── public/
│   ├── index.html              # Interfaccia dell'applicazione
│   ├── app.js                  # Logica client
│   ├── sw.js                   # Service Worker
│   └── manifest.webmanifest    # Configurazione PWA
├── lib/
│   └── excel-libere-uscite.js  # Raccolta iscritti e generazione Excel
├── templates/                  # Modelli Excel
└── db/                         # Script SQL di supporto
```

## Avvio in locale

Servono **Node.js 16 o successivo** e un database **MySQL** raggiungibile.

1. Clona il repository e installa le dipendenze:

   ```bash
   git clone https://github.com/Vito4k3/allieviufficiali.git
   cd allieviufficiali
   npm install
   ```

2. Predisponi un database MySQL compatibile con lo schema del progetto e configura nell’ambiente le variabili elencate in [`.env.example`](.env.example), almeno `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME` e `JWT_SECRET`. Per il recupero password configura anche il servizio email.

   Il file `.env.example` documenta i nomi delle variabili, ma il server legge i valori dall’ambiente di esecuzione: non inserire credenziali o chiavi nel repository.

3. Avvia il server:

   ```bash
   npm start
   ```

   Per lo sviluppo con riavvio automatico:

   ```bash
   npm run dev
   ```

   In locale l’app è disponibile su `http://localhost:3000`, salvo diversa configurazione della porta. All’avvio il server applica le migrazioni previste e crea le tabelle accessorie; il primo account amministratore viene inizializzato tramite la procedura di setup, disponibile una sola volta.

## Nota su dati e accessi

Il portale gestisce dati legati agli account e alle attività degli utenti. Una distribuzione deve usare credenziali robuste, variabili d’ambiente configurate correttamente e un database accessibile solo ai servizi autorizzati. Non pubblicare dati personali, credenziali o informazioni riservate in questo repository o in ambienti dimostrativi.

---

Progetto personale sviluppato per applicare competenze di progettazione e sviluppo web a un problema organizzativo concreto.
