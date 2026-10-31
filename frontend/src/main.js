import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import { ElDialog } from 'element-plus/es/components/dialog/index.mjs';

import 'element-plus/dist/index.css';
import './pilot/style.css';
import Workbench from './pilot/Workbench.vue';
import './pilot/dingtalk-callback';
const router=createRouter({history:createWebHashHistory(),routes:[
  {path:'/',component:()=>import('./pilot/Contracts.vue')},
  {path:'/reconciliation',component:()=>import('./pilot/Reconciliation.vue')},
  {path:'/contracts/:id',component:()=>import('./pilot/Review.vue')},
  {path:'/rules',component:()=>import('./pilot/Rules.vue')},
  {path:'/feedback',component:()=>import('./pilot/Feedback.vue')},
  {path:'/dingtalk',component:()=>import('./pilot/DingTalk.vue')},
  {path:'/settings',component:()=>import('./pilot/Settings.vue')},
  {path:'/operations',component:()=>import('./pilot/Operations.vue')},
  {path:'/:pathMatch(.*)*',redirect:'/'},
]});
createApp(Workbench).use(router).component('ElDialog',ElDialog).mount('#app');
