'use strict';
const path=require('node:path'),{createRequire}=require('node:module');
const builderRequire=createRequire(require.resolve('electron-builder'));
const asar=createRequire(builderRequire.resolve('app-builder-lib'))('@electron/asar');
if(require.main===module){const archive=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);asar.extractAll(archive,output);}
