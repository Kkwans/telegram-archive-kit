package main

import (
	"os"
	"path/filepath"
	"testing"

	"go.etcd.io/bbolt"
)

func TestReadTdlSessionBytesFromLockedFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data.kv")
	db, err := bbolt.Open(path, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Update(func(tx *bbolt.Tx) error {
		b, err := tx.CreateBucketIfNotExists([]byte("ns"))
		if err != nil {
			return err
		}
		if err := b.Put([]byte("session"), []byte("session-blob")); err != nil {
			return err
		}
		return b.Put([]byte("app"), []byte("desktop"))
	}); err != nil {
		t.Fatal(err)
	}
	// bbolt keeps the database open (and locked) while the snapshot is read.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	blob, app, err := readTdlSessionBytes(data, "ns")
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if string(blob) != "session-blob" || app != "desktop" {
		t.Fatalf("unexpected snapshot blob=%q app=%q", blob, app)
	}
}
