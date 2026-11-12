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
