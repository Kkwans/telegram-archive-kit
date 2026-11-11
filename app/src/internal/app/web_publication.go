package app

import "encoding/json"

// DecodePublicationArchive reads the built offline data without rebuilding or
// consulting the raw Telegram export.
func DecodePublicationArchive(data []byte) (*Archive, error) {
	return decodeBuiltArchive(data)
}

type PublicationOfficialExport = officialIndexedExport

func DecodePublicationOfficialIndex(data []byte) ([]PublicationOfficialExport, error) {
	var index officialIndexFile
	if err := json.Unmarshal(data, &index); err != nil {
		return nil, err
	}
	return index.Exports, nil
}

func (f *Facade) PublicationRoot() string { return f.libraryRoot() }
