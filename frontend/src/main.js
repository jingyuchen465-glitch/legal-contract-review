import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import { ElDialog } from 'element-plus/es/components/dialog/index.mjs';

import 'element-plus/dist/index.css';
import './pilot/style.css';
import './pilot/appearance.css';
import Workbench from './pilot/Workbench.vue';
import './pilot/dingtalk-callback';
const router=createRouter({history:createWebHashHistory(),routes:[
  ...(import.meta.env.DEV ? [{path:'/review-preview',component:()=>import('./pilot/WordReviewPreview.vue'),meta:{standalone:true}}] : []),
  {path:'/',component:()=>import('./pilot/Contracts.vue')},
  {path:'/reconciliation',component:()=>import('./pilot/Reconciliation.vue')},
  {path:'/auto-review',component:()=>import('./pilot/AutoReview.vue')},
  {path:'/auto-review/:id',component:()=>import('./pilot/AutoReview.vue')},
  {path:'/auto-review/:id/artifacts/:artifactId',component:()=>import('./pilot/AutoReviewDocument.vue')},
  {path:'/contracts/:id',component:()=>import('./pilot/AgentReview.vue')},
  {path:'/contracts/:id/history/:reviewId',component:()=>import('./pilot/HistoricalReview.vue')},
  {path:'/rules',component:()=>import('./pilot/LegacyKnowledge.vue')},
  {path:'/experience',component:()=>import('./pilot/AgentExperience.vue')},
  {path:'/experience/history',component:()=>import('./pilot/LegacyKnowledge.vue')},
  {path:'/review',redirect:'/'},
  {path:'/archive',redirect:'/'},
  {path:'/feedback',component:()=>import('./pilot/AgentEvaluationForm.vue')},
  {path:'/dingtalk/intakes/:id',component:()=>import('./pilot/Intake.vue')},
  {path:'/dingtalk',component:()=>import('./pilot/DingTalk.vue')},
  {path:'/settings',component:()=>import('./pilot/Settings.vue')},
  {path:'/operations',component:()=>import('./pilot/Operations.vue')},
  {path:'/:pathMatch(.*)*',redirect:'/'},
]});
createApp(Workbench).use(router).component('ElDialog',ElDialog).mount('#app');
