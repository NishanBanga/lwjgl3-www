//@flow
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const chalk = require('chalk');
const { fork } = require('child_process');
//$FlowFixMe
const Sema = require('async-sema');
const crypto = require('crypto');
//$FlowFixMe
const gzipSize = require('gzip-size');

/*
  POST PRODUCTION:

  * Build a list of assets by reading webpack manifest
  * Detect entry point
  * Mark route assets
    * For each route asset, store its chunk dependencies
    * We must be able to add preload headers for all deps when navigating to a route
    * e.g. entry point + route + route deps...
  * Process each asset in parallel
  * Generate application manifest
    * Store assets that need to be uploaded to the CDN
    * Store entrypoint
    * Store chunk dependencies for each route
  * Display report
*/

// We'll us this to detect route chunks
const routeRegExp = new RegExp('^route[-][a-z][a-z-_/]+$');

/*::
type ProductionManifest = {
  entry: number,
  routes: {
    [route: string]: Array<number>,
  },
  assets: {
    [id: string]: string,
  },
};

export type Asset = {
  id: number | string,
  name: string,
  file: string,
  cdn: string,
  route: boolean,
  src: string,
  hashSrc: string,
  hash: string,
  originalSize: number,
  size: number,
  gzipSize: number,
};

type AssetMap = Map<string|number, Asset>;

type ReportData = {
  manifest: ProductionManifest,
  assetMap: AssetMap,
};

type Processed = {
  [hashSrc: string]: {
    id: number | string,
    name: string,
    file: string,
    cdn: string,
    hash: string,
    originalSize: number,
    size: number,
    gzipSize: number,
  },
}
*/

function processedFromAsset({ id, name, file, cdn, hashSrc, hash, originalSize, size, gzipSize } /*: Asset*/) {
  return {
    id,
    name,
    file,
    cdn,
    hash,
    originalSize,
    size,
    gzipSize,
  };
}

async function main() /*: Promise<ReportData>*/ {
  console.log(chalk`{yellow Compiling list of files & routes:}`);

  // Read webpack's manifest & chunks into memory
  const manifest = require('../public/js/webpack.manifest.json');

  // Remember previously post-processed files and skip
  let processed /*: Processed */ = {};
  let hashMap = {};

  try {
    processed = JSON.parse(await readFile(path.join(__dirname, '../public/js/processed.json')));
  } catch (e) {}

  // We'll use this to store final production manifest
  const productionManifest /*: ProductionManifest */ = {
    // Boot the app from here
    entry: manifest.entrypoints.main.chunks[0],

    // Build a map of route paths->assets in order to preload chunks as needed
    routes: {},

    // Keep a list of files that we need to upload on the CDN
    assets: {},
  };

  // Build a map that contains each chunk
  // For each chunk we save its filename, id, and size
  const assetMap /*: AssetMap */ = new Map();

  manifest.assets.forEach(record => {
    const name = record.chunkNames[0];
    const src = fs.readFileSync(path.resolve(__dirname, '../public/js', record.name), { encoding: 'utf-8' });
    const hash = crypto.createHash('MD5');
    hash.update(src);
    const hashSrc = hash.digest('hex');

    let asset /*: Asset */ = {
      id: record.chunks[0],
      name,
      file: record.name,
      cdn: record.name,
      route: name.indexOf('~') === -1 && name.match(/^route[-]/) !== null,
      src,
      hashSrc,
      hash: '',
      originalSize: record.size,
      size: 0,
      gzipSize: 0,
    };

    if (processed[asset.hashSrc]) {
      // If we have already processed this file, we can skip heavy processing
      const previous = processed[asset.hashSrc];
      // Check for changes & if file still exists
      if (
        asset.id === previous.id &&
        asset.name === previous.name &&
        asset.file === previous.file &&
        fs.existsSync(path.resolve(__dirname, '../public/js', previous.cdn))
      ) {
        asset.cdn = previous.cdn;
        asset.hash = previous.hash;
        asset.size = previous.size;
        asset.gzipSize = previous.gzipSize;
      }

      productionManifest.assets[asset.id.toString()] = asset.cdn;
    }

    // Check if we haven't processed before
    if (asset.size === 0) {
      // Use pre-minified filename (will be replaced later). This is useful for debugging
      productionManifest.assets[asset.id.toString()] = asset.file;
    }

    // Add to asset map
    assetMap.set(asset.id, asset);
  });

  // Append route chunk dependencies
  Object.keys(manifest.namedChunkGroups).forEach(chunkName => {
    const groupData = manifest.namedChunkGroups[chunkName];
    const asset = assetMap.get(groupData.chunks.slice(-1)[0]);
    if (asset !== undefined && asset.route === true) {
      productionManifest.routes[asset.name.substr('route-'.length)] = groupData.chunks.reverse();
    }
  });

  /*
    ! BEGIN PARALLEL PROCESSING
  */

  // Hold Promises of jobs currently running
  const childMap = {};

  function processChunk(child, data) {
    return new Promise((resolve, reject) => {
      childMap[child.pid] = {
        resolve, // Call when msg.type === 'done'
        reject, // Call when msg.type === 'error'
      };

      // Begin job execution
      child.send(data);
    });
  }

  // Handle forked process messages
  function receiveChildMessage(msg) {
    switch (msg.type) {
      case 'done':
        childMap[msg.pid].resolve(msg.asset);
        break;
      case 'error':
        childMap[msg.pid].reject(msg.error);
        break;
    }

    childMap[msg.pid] = null;
  }

  // Create process pool -- We will process {CPU_CORES} chunks at a time
  const pool = new Sema(Math.max(os.cpus().length, 2), {
    initFn: () => {
      const child = fork('scripts/post-production-process.js');
      child.on('message', receiveChildMessage);
      return child;
    },
  });

  let runtimeChunk;

  await Promise.all(
    Array.from(assetMap.keys())
      .filter(chunkId => {
        let asset = assetMap.get(chunkId);
        return asset != null && asset.hash.length === 0;
      })
      .map(async chunkId => {
        // Get next available from pool
        const child = await pool.acquire();
        // Run process
        const asset = await processChunk(child, assetMap.get(chunkId));

        // Update asset & manifest
        assetMap.set(chunkId, asset);
        productionManifest.assets[chunkId.toString()] = asset.cdn;
        processed[asset.hashSrc] = processedFromAsset(asset);

        // Return to pool
        pool.release(child);
      })
  );

  // Drain forks
  (await pool.drain()).map(child => child.disconnect());

  // Replace entrypoint filenames with CDN version and update hash
  const entry = assetMap.get(productionManifest.entry);
  if (entry !== undefined) {
    let entryContents = await readFile(path.resolve(__dirname, '../public/js/', entry.cdn), { encoding: 'utf-8' });

    Array.from(assetMap.keys()).forEach(chunkId => {
      if (chunkId !== productionManifest.entry) {
        let asset = assetMap.get(chunkId);
        if (asset !== undefined) {
          entryContents = entryContents.replace(
            new RegExp(`["]?${chunkId}["]?[:]["]${asset.name.replace(/[$]/g, '[$]')}["]`),
            `${chunkId}:"${asset.cdn.slice(0, -3)}"`
          );
        }
      }
    });

    const hash = crypto.createHash('MD5');
    hash.update(entryContents);
    entry.hash = hash.digest('hex');
    entry.size = Buffer.byteLength(entryContents, 'utf8');
    entry.gzipSize = gzipSize.sync(entryContents);
    entry.cdn = `main.${entry.hash}.js`;

    productionManifest.assets[entry.id.toString()] = entry.cdn;
    await writeFile(path.resolve(__dirname, `../public/js/${entry.cdn}`), entryContents);
  }

  // Append manifest.json to deployment assets
  productionManifest.assets.manifest = 'manifest.json';

  // Hash and append core.css
  await (async () => {
    let contents = await readFile(path.resolve(__dirname, '../public/css/core.css'), { encoding: 'utf-8' });
    const MD5 = crypto.createHash('MD5');
    MD5.update(contents);
    const hash = MD5.digest('hex');

    const asset /*: Asset*/ = {
      id: 'css',
      name: 'core',
      file: 'core.css',
      cdn: `core.${hash}.css`,
      route: false,
      src: contents,
      hashSrc: hash,
      hash,
      originalSize: 0,
      size: 0,
      gzipSize: 0,
    };

    if (processed[hash]) {
      const previous = processed[hash];
      // Check for changes & if file still exists
      if (
        asset.id === previous.id &&
        asset.name === previous.name &&
        asset.file === previous.file &&
        fs.existsSync(path.resolve(__dirname, '../public/css', previous.cdn))
      ) {
        asset.originalSize = previous.originalSize;
        asset.size = previous.size;
        asset.gzipSize = previous.gzipSize;
      }
    }

    if (asset.size === 0) {
      asset.originalSize = Buffer.byteLength(contents, 'utf8');
      asset.size = asset.originalSize;
      asset.gzipSize = gzipSize.sync(contents);

      await writeFile(path.resolve(__dirname, `../public/css/${asset.cdn}`), contents);
      processed[asset.hashSrc] = processedFromAsset(asset);
    }

    productionManifest.assets.css = asset.cdn;
    assetMap.set('css', asset);
  })();

  // Store production manifest
  await writeFile(path.resolve(__dirname, '../public/js/manifest.json'), JSON.stringify(productionManifest, null, 2));

  // Remember processed files
  await writeFile(path.resolve(__dirname, '../public/js/processed.json'), JSON.stringify(processed, null, 2));

  // Done!
  return { manifest: productionManifest, assetMap };
}

function ellipsis(str /*:string*/, maxlength /*:number*/ = 25) {
  if (str.length > maxlength) {
    return str.substr(0, maxlength) + '...';
  }
  return str;
}

main()
  .then(({ manifest, assetMap }) => {
    // Print file report
    //$FlowFixMe
    const CliTable = require('cli-table');
    const prettyBytes = require('./prettyBytes');
    const formatSize = require('./formatSize');

    let sumOriginal = 0;
    let sum = 0;
    let sumGzip = 0;

    // Prepare table
    const tbl = new CliTable({
      head: ['File', 'Hash', 'Original', 'Optimized', 'Gzipped'],
      colAligns: ['left', 'left', 'right', 'right', 'right'],
      style: { head: ['cyan'] },
    });

    // Add rows
    Array.from(assetMap.values()).forEach((asset /*: Asset*/) => {
      sumOriginal += asset.originalSize;
      sum += asset.size;
      sumGzip += asset.gzipSize;

      const row = [];
      const isEntry = manifest.entry === asset.id || asset.id === 'css';

      if (isEntry) {
        row.push(chalk`{cyan > ${asset.name}}`);
      } else if (asset.route) {
        row.push(asset.name);
      } else {
        row.push(`* ${ellipsis(asset.name)}`);
      }

      row.push(
        asset.hash,
        prettyBytes(asset.originalSize),
        formatSize(asset.size, false, isEntry, false),
        formatSize(asset.gzipSize, true, isEntry, false)
      );

      tbl.push(row);
    });

    // Push totals
    tbl.push(['', chalk`{cyan TOTAL}`, prettyBytes(sumOriginal), prettyBytes(sum), prettyBytes(sumGzip)]);

    // Print report
    console.log(tbl.toString());
  })
  .catch(e => {
    console.log(e);
    process.exit(1);
  });
