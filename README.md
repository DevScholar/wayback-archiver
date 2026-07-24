# Wayback Archiver

## Download Files
From the "Network" tab in the browser console, copy all URLs that need to be archived.
Copy the URLs to the `user-private/urls.txt` file, with each URL on a separate line. Then run the `node downloader.js` file.

## Create Index Page
Run the `node indexer.js` file.    

## Run Server
Run the `node server.js` file.

## Flatten Archive
Run `node flatten.js` to convert the archive into a standalone folder that can be browsed without a server (file:// protocol).

```
node flatten.js --output-dir=<PATH> [--archive-dir=<PATH>] [--date=<YYYY[-MM][-DD]>]
```

| Argument | Required | Description |
|---|---|---|
| `--output-dir=<PATH>` | Yes | Output directory for the flattened archive |
| `--archive-dir=<PATH>` | No | Archive directory. Defaults to `config.json`'s `currentSaveLocation` |
| `--date=<YYYY[-MM][-DD]>` | No | Preferred date for selecting snapshots. Defaults to today |

This software is licensed under the MIT License.