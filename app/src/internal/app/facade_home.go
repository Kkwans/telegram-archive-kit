package app

import "telegramarchivekit/internal/platform"

type HomeStorageDTO struct {
	DiskFree  int64 `json:"diskFree"`
	DiskTotal int64 `json:"diskTotal"`
}

func (f *Facade) HomeStorage() HomeStorageDTO {
	free, total := platform.Space(f.libraryRoot())
	return HomeStorageDTO{DiskFree: free, DiskTotal: total}
}
