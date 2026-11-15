process.env.HOME = '/work';
const { buildBwrapCommand, SANDBOXED_SHELL } = await import('/app/dist/execution/bwrap/mount-policy.js');
const build = buildBwrapCommand({profile:'workspace-write',cwd:'/work	A16',writableRoots:[],networkEnabled:false,atlasHome:'/fakehome/.atlas',alwaysHidden:[]},'/usr/bin/bwrap',SANDBOXED_SHELL);
console.log('from inner node, tmpfs targets:', build.argv.filter((x,i)=>build.argv[i-1]==='--tmpfs').join(' | '));
