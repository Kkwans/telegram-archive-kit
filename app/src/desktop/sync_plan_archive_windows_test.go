package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestPlanStageMergesPagesWithoutReimportingKnownIDs(t *testing.T) {
	dir := t.TempDir()
	pages := map[string]string{
		"page-0.json":  `[{"id":12,"media_type":"video_file"},{"id":11,"media_type":"photo"}]`,
		"page-11.json": `[{"id":8,"text":"oldest"}]`,
	}
	for name, data := range pages {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	path, messages, media, pending, err := assemblePlanSource(dir, OnlineChat{ID: 1, Name: "Fixture"}, []string{"video"}, []string{"4"}, map[string]bool{"11": true})
	if err != nil || messages != 2 || media != 1 || !reflect.DeepEqual(pending, []string{"12", "4"}) {
		t.Fatalf("plan source result: %d messages, %d media, %v pending: %v", messages, media, pending, err)
	}
	data, err := os.ReadFile(path)
	var export struct{ Messages []struct{ ID int } }
	if err != nil || json.Unmarshal(data, &export) != nil || len(export.Messages) != 2 || export.Messages[0].ID != 8 || export.Messages[1].ID != 12 {
		t.Fatalf("staged history did not preserve message order: %+v, %v", export, err)
	}
}

func TestInitialFullHistoryDoesNotSucceedOnUnexpectedEmptyResult(t *testing.T) {
	plan := SyncPlan{FirstScope: "all"}
	chat := OnlineChat{LastMessageID: 101827}
	if err := validateInitialPlanHistory(plan, SyncPlanTarget{}, chat, SyncPlanCheckpoint{}, nil); err == nil {
		t.Fatal("an unarchived chat with known history was accepted as complete")
	}
	if err := validateInitialPlanHistory(plan, SyncPlanTarget{}, OnlineChat{}, SyncPlanCheckpoint{}, nil); err != nil {
		t.Fatalf("an actually empty chat was rejected: %v", err)
	}
	if err := validateInitialPlanHistory(SyncPlan{FirstScope: "30d"}, SyncPlanTarget{}, chat, SyncPlanCheckpoint{}, nil); err != nil {
		t.Fatalf("a limited history scope may have no messages: %v", err)
	}
}

func TestValidateInitialPlanHistoryRequiresScanEvidence(t *testing.T) {
	plan := SyncPlan{FirstScope: "all"}
	target := SyncPlanTarget{}
	chat := OnlineChat{LastMessageID: 900}
	existing := map[string]bool{}
	empty := SyncPlanCheckpoint{}
	if err := validateInitialPlanHistory(plan, target, chat, empty, existing); err == nil {
		t.Fatal("empty initial scan was reported as success")
	}
	scanned := SyncPlanCheckpoint{Through: 899}
	if err := validateInitialPlanHistory(plan, target, chat, scanned, existing); err != nil {
		t.Fatalf("scan that saw history was rejected: %v", err)
	}
	archived := SyncPlanCheckpoint{}
	existing["1"] = true
	if err := validateInitialPlanHistory(plan, target, chat, archived, existing); err != nil {
		t.Fatalf("already archived chat was rejected: %v", err)
	}
}
