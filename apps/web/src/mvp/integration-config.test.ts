import {describe, expect, it} from 'vitest';
import {integrationConfig} from './integration-config.ts';

describe('integration configuration', () => {
  it('has exactly internal and client contours', () => {
    expect(integrationConfig(null)).toMatchObject({hermes:false,
      channels:{internal:{configured:false,allowedUsers:0},client:{configured:false,allowedUsers:0}}});
  });

  it('derives provider and participants from the project runtime binding', () => {
    expect(integrationConfig(null,{internal:{provider:'telegram',status:'ready',allowedUsers:['42','43']},client:{provider:'element',status:'interactive',allowedUsers:[]}})).toMatchObject({hermes:false,
      channels:{internal:{provider:'telegram',configured:true,allowedUsers:2},client:{provider:'element',configured:true,allowedUsers:0}}});
  });

});
