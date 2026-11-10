package platform

import (
	"errors"
	"os"
)

// ProbeDirectoryWrite is used only for an explicit connection test. The
// exclusive temporary file avoids overwriting existing data or another probe.
func ProbeDirectoryWrite(root string) error {
	f, err := os.CreateTemp(root, ".tak-write-test-*")
	if err != nil {
		return err
	}
	_, writeErr := f.WriteString("ok")
	closeErr := f.Close()
	return errors.Join(writeErr, closeErr, os.Remove(f.Name()))
}
