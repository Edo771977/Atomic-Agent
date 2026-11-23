# Apprendimento delle skill con approvazione

Status: current
Owner: src/skills/

Confronto di `feat/ato-67-self-learning` a `b17ecacb8043d4f10e8a0854f9ece610c7468dac` con le lezioni del fork. [Upstream #1696](https://github.com/AtomicBot-ai/atomic-agent/pull/1696)

| Aspetto | Upstream | Lezioni del fork | Skill imparate |
| --- | --- | --- | --- |
| Chi scrive | Il revisore crea o aggiorna; contenuto esterno e alcuni canali producono bozze. | Il director crea proposte (#177); la persona decide. | Il revisore crea solo bozze, anche per un aggiornamento. |
| Attivazione | Automatica per i turni locali senza taint; manuale per le bozze. | Stato active e approvazione della versione corrente. | Decisione esplicita tra turni, legata allo SHA-256 dei byte mostrati. Un cambio richiede una nuova lettura. Il processo marcato ATOMIC_AGENT_TOOL_CHILD viene rifiutato. |
| Vista | Testo completo, metadati e diff per una modifica. | Testo e impronta, con ricaricamento su modifica. | Testo completo, impronta e diff per un aggiornamento, con ricaricamento al rifiuto per impronta vecchia. |
| Annullamento | Archivio per una creazione, ripristino per una modifica. Solo la modifica più recente è annullabile. | Ritiro o riapertura della decisione associata all'impronta. | Conservare cronologia e undo nello stesso ambito della skill. |
| File e isolamento | Stato globale, bozze separate dalle skill, esclusi target di progetto, starter, hub, plugin e condivisi. | Markdown nel progetto; decisioni protette in stato locale e vincolate al progetto. Restrizioni del provider rispettate. | Bozze e skill in stato locale con ambito di progetto. Nessuna propagazione implicita al catalogo globale. Rispettare le cartelle riservate. |
| Prompt e limiti | Solo le skill attive entrano nel catalogo; corpo su skill.view. Limiti di 16 KiB, 500 righe di corpo e 300 caratteri di descrizione. | Lezioni attive e approvate in coda al prompt; dimensioni e numero limitati. | Stessi limiti delle skill upstream sul percorso di lettura. Nessuna bozza nel catalogo o nella coda. A funzione spenta, stessi byte del prompt. |
| Caratteri invisibili | Sanitizzazione della vista terminale per i controlli. | Il lettore rifiuta caratteri invisibili e di controllo (#184). | Stessa regola delle lezioni sia alla validazione sia alla lettura. |
| Incognito | Revisione saltata. | Nessuna decisione sulle lezioni viene persistita. | Revisione e attivazione rifiutate. |
| Worker Fusion | Revisione saltata. | Ricevono lezioni pertinenti al lavoro dichiarato e alle citazioni del piano. | Nessuna revisione nei worker e nessuna esposizione trasversale delle skill imparate. |
 
Upstream abilita la funzione per impostazione predefinita. Il fork mantiene l'apprendimento disattivato per impostazione predefinita.
